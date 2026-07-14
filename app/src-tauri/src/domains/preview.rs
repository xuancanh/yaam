//! Rich HTML file previews served through a custom URI scheme so the rendered
//! page gets its OWN policy container.
//!
//! Sandboxed `srcdoc` iframes INHERIT the embedding document's CSP — WebKit
//! (macOS WKWebView) implements CSP inheritance for `about:srcdoc` / `blob:` /
//! `data:` — so the app's hardened `script-src 'self'` policy is intersected
//! into every preview and blocks its inline scripts (the page renders blank).
//! A custom scheme is NOT a local scheme, so the served document is governed
//! only by its own headers/meta: inline (and, when unlocked, external) scripts
//! run, while the privileged app WebView keeps its strict CSP untouched. The
//! iframe stays sandboxed and on a distinct origin, so a preview can never
//! reach back into the app.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext};

/// Previews load from `yaampreview://localhost/<id>` (macOS/Linux) or
/// `http://yaampreview.localhost/<id>` (Windows) — build the URL frontend-side
/// with `convertFileSrc(id, 'yaampreview')`.
pub const PREVIEW_SCHEME: &str = "yaampreview";

/// Cap on retained previews. The frontend clears each one when it closes, but
/// this bounds memory if a cleanup is ever missed (previews are transient).
const MAX_PREVIEWS: usize = 32;

#[derive(Default)]
struct Inner {
    map: HashMap<String, String>,
    order: VecDeque<String>,
    seq: u64,
}

#[derive(Default)]
pub struct PreviewStore(Mutex<Inner>);

/// Stash one rendered HTML document and return its id (the id becomes the path
/// of the custom-scheme URL the iframe loads).
#[tauri::command]
pub fn preview_stash(store: tauri::State<'_, PreviewStore>, html: String) -> String {
    let mut inner = store.0.lock().unwrap();
    inner.seq += 1;
    let id = inner.seq.to_string();
    inner.map.insert(id.clone(), html);
    inner.order.push_back(id.clone());
    while inner.order.len() > MAX_PREVIEWS {
        if let Some(old) = inner.order.pop_front() {
            inner.map.remove(&old);
        }
    }
    id
}

/// Drop a stashed preview once its viewer closes or reloads.
#[tauri::command]
pub fn preview_clear(store: tauri::State<'_, PreviewStore>, id: String) {
    let mut inner = store.0.lock().unwrap();
    if inner.map.remove(&id).is_some() {
        inner.order.retain(|x| x != &id);
    }
}

/// Custom-scheme handler: serve the stashed HTML for `/<id>` as a real document
/// with no CSP header of its own (the document's meta, if any, is the policy).
pub fn preview_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let id = req.uri().path().trim_start_matches('/').to_string();
    let html = ctx
        .app_handle()
        .state::<PreviewStore>()
        .0
        .lock()
        .unwrap()
        .map
        .get(&id)
        .cloned();
    match html {
        Some(h) => Response::builder()
            .status(200)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Cache-Control", "no-store")
            .body(h.into_bytes())
            .unwrap(),
        None => Response::builder()
            .status(404)
            .body(b"preview not found".to_vec())
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_returns_distinct_ids_and_retrieves() {
        let store = PreviewStore::default();
        let a = {
            let mut i = store.0.lock().unwrap();
            i.seq += 1;
            let id = i.seq.to_string();
            i.map.insert(id.clone(), "<b>a</b>".into());
            i.order.push_back(id.clone());
            id
        };
        let b = {
            let mut i = store.0.lock().unwrap();
            i.seq += 1;
            let id = i.seq.to_string();
            i.map.insert(id.clone(), "<b>b</b>".into());
            i.order.push_back(id.clone());
            id
        };
        assert_ne!(a, b);
        let i = store.0.lock().unwrap();
        assert_eq!(i.map.get(&a).unwrap(), "<b>a</b>");
        assert_eq!(i.map.get(&b).unwrap(), "<b>b</b>");
    }

    #[test]
    fn evicts_oldest_beyond_cap() {
        let store = PreviewStore::default();
        for n in 0..(MAX_PREVIEWS + 5) {
            let mut i = store.0.lock().unwrap();
            i.seq += 1;
            let id = i.seq.to_string();
            i.map.insert(id.clone(), format!("doc {n}"));
            i.order.push_back(id.clone());
            while i.order.len() > MAX_PREVIEWS {
                if let Some(old) = i.order.pop_front() {
                    i.map.remove(&old);
                }
            }
        }
        let i = store.0.lock().unwrap();
        assert_eq!(i.map.len(), MAX_PREVIEWS);
        assert!(i.map.get("1").is_none(), "oldest evicted");
        assert!(i.map.get(&i.seq.to_string()).is_some(), "newest retained");
    }
}
