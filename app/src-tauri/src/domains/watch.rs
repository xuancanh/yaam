//! Filesystem watching for the workspace file pane. A recursive `notify` watcher
//! per workspace root coalesces bursts of change events and emits a single
//! `fs-change` event to the frontend, so the UI can refresh on demand instead of
//! polling the tree, open file, and git status on fixed timers.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Quiet window used to coalesce a burst of filesystem events into one emit. A
/// save often produces several events (write, chmod, rename-in); batching them
/// keeps the UI from refreshing many times for one logical change.
const DEBOUNCE_MS: u64 = 250;
const MAX_WATCHERS: usize = 64;
const MAX_QUEUED_EVENTS: usize = 1024;
const MAX_BATCH_PATHS: usize = 10_000;

#[derive(Default)]
pub struct WatchManager {
    /// one active watcher per canonical root; re-watching a root replaces it
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Clone, Serialize)]
struct FsChangeEvent {
    root: String,
    paths: Vec<String>,
}

/// Dedup + sort changed paths, dropping any inside an ignored directory (`.git`,
/// `node_modules`) so VCS and dependency churn don't spam the UI — the file tree
/// hides those anyway. Pulled out as a pure function so it is unit-testable
/// without a live watcher.
fn dedup_visible_paths<I: IntoIterator<Item = PathBuf>>(paths: I) -> Vec<String> {
    let mut out: Vec<String> = paths
        .into_iter()
        .filter(|p| {
            !p.components().any(|c| {
                matches!(c.as_os_str().to_str(), Some(".git") | Some("node_modules"))
            })
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    out.dedup();
    out
}

impl WatchManager {
    /// Start (or replace) a recursive watch on `root`. Change bursts are coalesced
    /// on a background thread and delivered to the frontend as `fs-change`.
    /// Returns the canonical root key carried by every emitted event, so the
    /// caller can filter the shared `fs-change` stream down to its own root.
    pub fn watch(&self, app: AppHandle, root: String) -> Result<String, String> {
        let canon = std::fs::canonicalize(crate::util::expand_tilde(&root))
            .map_err(|e| format!("watch root unavailable: {e}"))?;
        if !canon.is_dir() { return Err("watch root is not a directory".to_string()); }
        let root_key = canon.to_string_lossy().into_owned();
        {
            let watchers = self.watchers.lock().map_err(|e| e.to_string())?;
            if !watchers.contains_key(&root_key) && watchers.len() >= MAX_WATCHERS {
                return Err(format!("too many watched roots (max {MAX_WATCHERS})"));
            }
        }

        // The notify callback runs on notify's own thread; it just forwards events
        // to the debounce thread through a channel.
        let (tx, rx) = mpsc::sync_channel::<notify::Event>(MAX_QUEUED_EVENTS);
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    // A refresh consumes current filesystem state, so dropping
                    // redundant storm events is safer than unbounded buffering.
                    let _ = tx.try_send(event);
                }
            })
            .map_err(|e| e.to_string())?;
        watcher
            .watch(&canon, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        // Debounce + coalesce: block for the first event, then drain until the
        // filesystem has been quiet for DEBOUNCE_MS, and emit one batched event.
        // rx closes when the watcher is dropped (unwatch or replace), ending the loop.
        let emit_root = root_key.clone();
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch: Vec<PathBuf> = first.paths;
                while let Ok(ev) = rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                    let remaining = MAX_BATCH_PATHS.saturating_sub(batch.len());
                    batch.extend(ev.paths.into_iter().take(remaining));
                }
                batch.truncate(MAX_BATCH_PATHS);
                let paths = dedup_visible_paths(batch);
                if !paths.is_empty() {
                    let _ = app.emit(
                        "fs-change",
                        FsChangeEvent {
                            root: emit_root.clone(),
                            paths,
                        },
                    );
                }
            }
        });

        // Inserting drops any previous watcher for this root, which closes its
        // channel and lets its debounce thread exit cleanly.
        self.watchers.lock().unwrap().insert(root_key.clone(), watcher);
        Ok(root_key)
    }

    /// Stop watching `root` (dropping the watcher and ending its debounce thread).
    pub fn unwatch(&self, root: &str) {
        // Match the stored canonical key; fall back to the raw path if the root
        // no longer resolves (e.g. it was deleted).
        let key = std::fs::canonicalize(crate::util::expand_tilde(root))
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| root.to_string());
        self.watchers.lock().unwrap().remove(&key);
    }
}

#[tauri::command]
pub fn watch_dir(
    app: AppHandle,
    state: State<'_, WatchManager>,
    root: String,
) -> Result<String, String> {
    state.watch(app, root)
}

#[tauri::command]
pub fn unwatch_dir(state: State<'_, WatchManager>, root: String) {
    state.unwatch(&root);
}

#[cfg(test)]
mod tests {
    use super::dedup_visible_paths;
    use notify::{RecursiveMode, Watcher};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn dedups_and_sorts_changed_paths() {
        let paths = vec![
            PathBuf::from("/w/b.txt"),
            PathBuf::from("/w/a.txt"),
            PathBuf::from("/w/b.txt"),
        ];
        assert_eq!(dedup_visible_paths(paths), vec!["/w/a.txt", "/w/b.txt"]);
    }

    #[test]
    fn drops_git_and_node_modules_churn() {
        let paths = vec![
            PathBuf::from("/w/.git/index"),
            PathBuf::from("/w/node_modules/x/pkg.json"),
            PathBuf::from("/w/src/main.rs"),
        ];
        assert_eq!(dedup_visible_paths(paths), vec!["/w/src/main.rs"]);
    }

    // Real end-to-end check that the native watch path actually fires: watch a
    // temp dir, write a file, and assert notify reports it. Generous timeout
    // because macOS FSEvents delivery is asynchronous.
    #[test]
    fn notify_reports_a_written_file() {
        let dir = std::env::temp_dir().join(format!("yaam-watch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canon = std::fs::canonicalize(&dir).unwrap();

        let (tx, rx) = mpsc::channel::<notify::Event>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                let _ = tx.send(ev);
            }
        })
        .unwrap();
        watcher.watch(&canon, RecursiveMode::Recursive).unwrap();

        let target = canon.join("hello.txt");
        std::fs::write(&target, "hi").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut saw = false;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(ev) => {
                    if ev
                        .paths
                        .iter()
                        .any(|p| p.file_name().and_then(|n| n.to_str()) == Some("hello.txt"))
                    {
                        saw = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
        assert!(saw, "expected a notify event mentioning hello.txt");
    }
}
