//! Remote companion: a tiny token-authenticated HTTP server so a phone on the
//! same network can watch the fleet and answer approvals. Deliberately
//! read-mostly: the ONLY mutation the remote can perform is enqueueing an
//! approve/deny decision, which the frontend polls and applies through its
//! normal action paths. Execution and credentials never leave this machine.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteDecision {
    /// 'master' (tool approval) or 'chat' (ask-mode approval)
    pub kind: String,
    pub id: String,
    /// chat approvals also carry the owning agent id
    #[serde(default)]
    pub agent_id: String,
    pub ok: bool,
}

const PAGE: &str = include_str!("remote-page.html");

fn rand_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ (std::process::id() as u64) << 32;
    let mut out = String::new();
    for _ in 0..24 {
        // xorshift — no crypto needed beyond unguessability on a LAN
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.push(char::from_digit((seed % 36) as u32, 36).unwrap_or('x'));
    }
    out
}

/// Best-effort LAN address (UDP connect trick — nothing is actually sent).
fn local_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn query_token(url: &str) -> Option<&str> {
    url.split_once("t=").map(|(_, t)| t.split('&').next().unwrap_or(""))
}

fn respond_json(req: tiny_http::Request, code: u16, body: String) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
    let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(code).with_header(header));
}

fn serve(state: Arc<StateHandles>, server: Arc<tiny_http::Server>, stopped: Arc<AtomicBool>) {
    for mut req in server.incoming_requests() {
        if stopped.load(Ordering::Relaxed) {
            break;
        }
        let url = req.url().to_string();
        let expected = state.token.lock().unwrap().clone();
        let authed = !expected.is_empty() && query_token(&url) == Some(expected.as_str());

        if url.starts_with("/api/state") {
            if !authed {
                respond_json(req, 403, "{\"error\":\"bad token\"}".into());
                continue;
            }
            let body = state.snapshot.lock().unwrap().clone();
            respond_json(req, 200, if body.is_empty() { "{}".into() } else { body });
        } else if url.starts_with("/api/decision") {
            if !authed {
                respond_json(req, 403, "{\"error\":\"bad token\"}".into());
                continue;
            }
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            match serde_json::from_str::<RemoteDecision>(&body) {
                Ok(d) => {
                    state.decisions.lock().unwrap().push(d);
                    respond_json(req, 200, "{\"ok\":true}".into());
                }
                Err(e) => respond_json(req, 400, format!("{{\"error\":\"{e}\"}}")),
            }
        } else {
            // the page itself checks the token before polling
            let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
            let _ = req.respond(tiny_http::Response::from_string(PAGE).with_header(header));
        }
    }
}

/// The interior mutexes, shared with the server thread without the Tauri state wrapper.
struct StateHandles {
    snapshot: Mutex<String>,
    decisions: Mutex<Vec<RemoteDecision>>,
    token: Mutex<String>,
}

// RemoteState delegates its shared fields to an Arc the thread can own.
pub struct RemoteManager {
    handles: Arc<StateHandles>,
    server: Mutex<Option<(Arc<tiny_http::Server>, Arc<AtomicBool>)>>,
}

impl Default for RemoteManager {
    fn default() -> Self {
        Self {
            handles: Arc::new(StateHandles {
                snapshot: Mutex::new(String::new()),
                decisions: Mutex::new(Vec::new()),
                token: Mutex::new(String::new()),
            }),
            server: Mutex::new(None),
        }
    }
}

#[derive(Serialize)]
pub struct RemoteInfo {
    pub url: String,
    pub token: String,
}

#[tauri::command]
pub fn remote_start(state: tauri::State<'_, RemoteManager>, port: Option<u16>) -> Result<RemoteInfo, String> {
    let mut server_slot = state.server.lock().unwrap();
    if server_slot.is_some() {
        let token = state.handles.token.lock().unwrap().clone();
        return Ok(RemoteInfo { url: format!("http://{}:{}/?t={}", local_ip(), port.unwrap_or(8712), token), token });
    }
    let port = port.unwrap_or(8712);
    let server = tiny_http::Server::http(("0.0.0.0", port)).map_err(|e| format!("could not bind port {port}: {e}"))?;
    let server = Arc::new(server);
    let stopped = Arc::new(AtomicBool::new(false));
    let token = rand_token();
    *state.handles.token.lock().unwrap() = token.clone();
    let thread_state = state.handles.clone();
    let thread_server = server.clone();
    let thread_stopped = stopped.clone();
    std::thread::spawn(move || serve(thread_state, thread_server, thread_stopped));
    *server_slot = Some((server, stopped));
    Ok(RemoteInfo { url: format!("http://{}:{}/?t={}", local_ip(), port, token), token })
}

#[tauri::command]
pub fn remote_stop(state: tauri::State<'_, RemoteManager>) {
    if let Some((server, stopped)) = state.server.lock().unwrap().take() {
        stopped.store(true, Ordering::Relaxed);
        server.unblock();
    }
    state.handles.token.lock().unwrap().clear();
    state.handles.snapshot.lock().unwrap().clear();
    state.handles.decisions.lock().unwrap().clear();
}

#[tauri::command]
pub fn remote_publish(state: tauri::State<'_, RemoteManager>, json: String) {
    *state.handles.snapshot.lock().unwrap() = json;
}

#[tauri::command]
pub fn remote_take_decisions(state: tauri::State<'_, RemoteManager>) -> Vec<RemoteDecision> {
    std::mem::take(&mut *state.handles.decisions.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::{query_token, rand_token, RemoteDecision};

    #[test]
    fn tokens_are_long_and_unique() {
        let a = rand_token();
        let b = rand_token();
        assert_eq!(a.len(), 24);
        assert_ne!(a, b);
    }

    #[test]
    fn extracts_the_token_from_query_strings() {
        assert_eq!(query_token("/api/state?t=abc123"), Some("abc123"));
        assert_eq!(query_token("/api/decision?t=abc&x=1"), Some("abc"));
        assert_eq!(query_token("/api/state"), None);
    }

    #[test]
    fn decisions_round_trip_through_serde() {
        let d: RemoteDecision =
            serde_json::from_str("{\"kind\":\"chat\",\"id\":\"m1\",\"agent_id\":\"a1\",\"ok\":true}").unwrap();
        assert!(d.ok);
        assert_eq!(d.agent_id, "a1");
    }
}
