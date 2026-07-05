//! PTY session engine: owns the live child processes, streams their output to
//! the frontend, and reaps them on exit. This is the domain logic behind the
//! session commands — the managed `SessionManager` state lives here.
use crate::util::expand_tilde;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

// ── remote terminal taps ─────────────────────────────────────────────────
// Rust owns the PTY bytes, so multi-device terminal sync happens HERE: each
// session keeps a bounded ring of recent raw output plus a broadcast channel.
// The remote server replays the ring to a connecting device and then streams
// live chunks — no desktop-webview round trip, so every screen stays in sync
// even while the desktop UI is busy.

const TAP_RING_CAP: usize = 200_000;
const TAP_CHANNEL_CAP: usize = 512;

struct SessionTap {
    ring: std::collections::VecDeque<u8>,
    tx: tokio::sync::broadcast::Sender<Vec<u8>>,
}

fn taps() -> &'static Mutex<HashMap<String, SessionTap>> {
    static TAPS: OnceLock<Mutex<HashMap<String, SessionTap>>> = OnceLock::new();
    TAPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tap_entry<'a>(map: &'a mut HashMap<String, SessionTap>, id: &str) -> &'a mut SessionTap {
    map.entry(id.to_string()).or_insert_with(|| SessionTap {
        ring: std::collections::VecDeque::new(),
        tx: tokio::sync::broadcast::channel(TAP_CHANNEL_CAP).0,
    })
}

pub(crate) fn tap_push(id: &str, bytes: &[u8]) {
    let mut map = taps().lock().unwrap();
    let tap = tap_entry(&mut map, id);
    tap.ring.extend(bytes.iter().copied());
    let excess = tap.ring.len().saturating_sub(TAP_RING_CAP);
    if excess > 0 {
        tap.ring.drain(..excess);
    }
    let _ = tap.tx.send(bytes.to_vec());
}

/// Ring backlog + live receiver for one session's raw terminal output.
pub fn tap_subscribe(id: &str) -> (Vec<u8>, tokio::sync::broadcast::Receiver<Vec<u8>>) {
    let mut map = taps().lock().unwrap();
    let tap = tap_entry(&mut map, id);
    (tap.ring.iter().copied().collect(), tap.tx.subscribe())
}

pub(crate) fn tap_remove(id: &str) {
    taps().lock().unwrap().remove(id);
}

/// Resolve a shell name with the user's login PATH without interpolating it
/// into shell code.
fn resolve_login_executable(executable: &str) -> Result<String, String> {
    let requested = expand_tilde(executable.trim());
    if requested.is_empty() {
        return Err("terminal shell is empty".to_string());
    }
    if requested.contains('/') {
        return std::path::Path::new(&requested)
            .is_file()
            .then_some(requested.clone())
            .ok_or_else(|| format!("terminal shell does not exist: {requested}"));
    }
    let out = Command::new("/bin/sh")
        .args(["-lc", "command -v \"$1\""])
        .arg("yaam-shell-resolver")
        .arg(&requested)
        .output()
        .map_err(|e| format!("failed to resolve terminal shell `{requested}`: {e}"))?;
    let resolved = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string();
    if !out.status.success() || resolved.is_empty() || !std::path::Path::new(&resolved).is_file() {
        return Err(format!(
            "terminal shell not found in login PATH: {requested}"
        ));
    }
    Ok(resolved)
}

/// Select the executable, arguments, and SHELL value for command or terminal mode.
fn session_launch_spec(
    command: &str,
    terminal_shell: Option<&str>,
) -> Result<(String, Vec<String>, Option<String>), String> {
    if let Some(shell) = terminal_shell.filter(|shell| !shell.trim().is_empty()) {
        let executable = resolve_login_executable(shell)?;
        return Ok((
            executable.clone(),
            vec!["-l".to_string(), "-i".to_string()],
            Some(executable),
        ));
    }
    Ok((
        "/bin/sh".to_string(),
        vec!["-lc".to_string(), command.to_string()],
        None,
    ))
}

struct SessionHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// child pid, for graceful (SIGTERM→SIGKILL) shutdown of the process tree
    pid: Option<i32>,
    /// distinguishes a resumed session reusing the same id from the one whose
    /// exit thread is still in flight
    generation: u64,
}

/// Grace period between the polite SIGTERM and the forced SIGKILL. CLIs use it to
/// flush their session/resume files instead of dying mid-write.
const SHUTDOWN_GRACE_MS: u64 = 2000;

/// Bounded depth of the per-session output queue between the PTY reader and the
/// emitter thread. A slow/blocked webview backpressures the reader (which in turn
/// throttles the child via the PTY) instead of letting output buffer without limit.
const OUTPUT_CHANNEL_CAP: usize = 256;

/// Upper bound on how many bytes the emitter merges into a single IPC event when
/// output is backed up. Chunks that are already queued get coalesced so a burst
/// crosses the bridge as a few large events rather than thousands of tiny ones;
/// when the webview keeps up this is a no-op (one chunk in → one event out).
const OUTPUT_COALESCE_MAX_BYTES: usize = 64 * 1024;

/// Merge `first` with any chunks already waiting on `rest`, up to `max_bytes`.
/// Returns the merged buffer and the number of source chunks it consumed. It keeps
/// pulling ready chunks while the buffer is still under `max_bytes`, so the result
/// may overshoot by at most one chunk (each chunk is a single bounded PTY read).
/// Pulled out as a pure function so coalescing is unit-testable without a live PTY
/// or `AppHandle`.
fn coalesce_output(first: Vec<u8>, rest: &mpsc::Receiver<Vec<u8>>, max_bytes: usize) -> (Vec<u8>, usize) {
    let mut merged = first;
    let mut count = 1;
    while merged.len() < max_bytes {
        match rest.try_recv() {
            Ok(chunk) => {
                merged.extend_from_slice(&chunk);
                count += 1;
            }
            Err(_) => break,
        }
    }
    (merged, count)
}

/// Shut a session's process down gracefully: ask its process group to terminate
/// (SIGTERM), then force-kill after a grace period. On non-unix (or without a
/// pid) fall back to the immediate forced kill. Runs the force step on its own
/// thread so callers (kill / id-reuse replace) never block.
fn shutdown_process(pid: Option<i32>, mut killer: Box<dyn ChildKiller + Send + Sync>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            // signal the child and its process group; ESRCH (already gone) is harmless
            libc::kill(pid, libc::SIGTERM);
            libc::kill(-pid, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(SHUTDOWN_GRACE_MS));
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = killer.kill(); // drop the pty child handle / reap
        });
        return;
    }
    let _ = killer.kill();
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    next_generation: std::sync::atomic::AtomicU64,
}

#[derive(Clone, Serialize)]
struct DataEvent {
    id: String,
    /// base64-encoded raw PTY bytes
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

impl SessionManager {
    /// Spawn a command or direct terminal shell and stream PTY events to React.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        command: String,
        terminal_shell: Option<String>,
        cwd: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.unwrap_or(24),
                cols: cols.unwrap_or(80),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // Plain terminals run the selected shell directly. Arbitrary commands still
        // need a login-shell parser for quoting, operators, and the user's GUI PATH.
        let (executable, args, shell_env) =
            session_launch_spec(&command, terminal_shell.as_deref())?;
        let launch_label = if shell_env.is_some() {
            format!("{executable} -l -i")
        } else {
            command.clone()
        };
        let mut cmd = CommandBuilder::new(executable);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        if let Some(shell) = shell_env {
            cmd.env("SHELL", shell);
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            let dir = expand_tilde(&dir);
            if !std::path::Path::new(&dir).is_dir() {
                return Err(format!("working directory does not exist: {dir}"));
            }
            cmd.cwd(dir);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn `{launch_label}`: {e}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id().map(|p| p as i32);

        let generation = self
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut sessions = self.sessions.lock().unwrap();
            // Reusing a live id: explicitly shut the old process down first.
            // Merely dropping the replaced handle leaks the child (dropping the
            // killer does not terminate it). The exit reaper for the old
            // generation then sees the newer handle and stays quiet.
            if let Some(old) = sessions.remove(&id) {
                shutdown_process(old.pid, old.killer);
            }
            sessions.insert(
                id.clone(),
                SessionHandle {
                    master: pair.master,
                    writer,
                    killer,
                    pid,
                    generation,
                },
            );
        }

        // Stream raw PTY output to the frontend through a bounded queue. The reader
        // thread only reads and enqueues; a dedicated emitter thread coalesces any
        // backed-up chunks into one IPC event. The bounded channel means a webview
        // that can't keep up backpressures the reader (and thus the child) rather
        // than letting output buffer without limit.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_CHANNEL_CAP);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    // send blocks when the queue is full — the desired backpressure.
                    // A closed receiver (emitter gone) means we should stop reading.
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let app_out = app.clone();
        let id_out = id.clone();
        std::thread::spawn(move || {
            // recv blocks until the next chunk; then merge whatever else is already
            // queued into the same event. Exits when the reader drops its sender.
            while let Ok(first) = rx.recv() {
                let (merged, _coalesced) = coalesce_output(first, &rx, OUTPUT_COALESCE_MAX_BYTES);
                // tee raw bytes to remote subscribers (mobile companion terminals)
                tap_push(&id_out, &merged);
                let data = base64::engine::general_purpose::STANDARD.encode(&merged);
                let _ = app_out.emit(
                    "session-data",
                    DataEvent {
                        id: id_out.clone(),
                        data,
                    },
                );
            }
        });

        // reap the child and notify the frontend when it exits
        let app_exit = app;
        let id_exit = id;
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let mgr = app_exit.state::<SessionManager>();
            let mut sessions = mgr.sessions.lock().unwrap();
            // a stop + relaunch can reuse this id before we get here — never
            // remove (or report exit for) a newer session's handle
            let stale = sessions
                .get(&id_exit)
                .map(|h| h.generation != generation)
                .unwrap_or(false);
            if !stale {
                sessions.remove(&id_exit);
            }
            drop(sessions);
            if !stale {
                let _ = app_exit.emit("session-exit", ExitEvent { id: id_exit, code });
            }
        });

        Ok(())
    }

    /// Write text to a session's PTY writer and flush it immediately.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let handle = sessions.get_mut(id).ok_or("no such session")?;
        handle
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| handle.writer.flush())
            .map_err(|e| e.to_string())
    }

    /// Resize a session's PTY so terminal applications receive SIGWINCH.
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id).ok_or("no such session")?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Remove a managed session and shut its child down gracefully (SIGTERM,
    /// then SIGKILL after a grace period) so CLIs can flush session files.
    pub fn kill(&self, id: &str) {
        if let Some(handle) = self.sessions.lock().unwrap().remove(id) {
            shutdown_process(handle.pid, handle.killer);
        }
    }

    /// Ids of PTYs still registered with the manager.
    pub fn live_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

/// Collect candidate session files whose creation time falls in [since, until].
/// Creation time (not mtime) prevents an older, concurrently active session
/// from shadowing the file created by the process being detected.
fn files_in_window(
    dir: &std::path::Path,
    since_ms: u64,
    until_ms: u64,
    recurse: bool,
    matches: &dyn Fn(&std::path::Path) -> bool,
    out: &mut Vec<(u64, std::path::PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recurse {
                files_in_window(&path, since_ms, until_ms, true, matches, out);
            }
            continue;
        }
        if !matches(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let created = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        if let Some(created) = created {
            if created >= since_ms && created <= until_ms {
                out.push((created, path));
            }
        }
    }
}

/// Turn a session file path into the CLI's resume id for the given kind.
fn derive_session_id(kind: &str, path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    match kind {
        // ~/.codex/sessions/.../rollout-<ts>-<uuid>.jsonl -> trailing UUID
        "codex" if stem.len() >= 36 => Some(stem[stem.len() - 36..].to_string()),
        // Claude and OpenCode use the complete file stem.
        _ => Some(stem),
    }
}

fn select_session_id(
    kind: &str,
    candidates: &mut [(u64, std::path::PathBuf)],
    exclude: &[String],
) -> Option<String> {
    candidates.sort_by_key(|(created, _)| *created);
    let mut seen = std::collections::HashSet::new();
    for (_, path) in candidates {
        let Some(id) = derive_session_id(kind, path) else {
            continue;
        };
        if seen.insert(id.clone()) && !exclude.contains(&id) {
            return Some(id);
        }
    }
    None
}

type SessionStoreSpec = (
    std::path::PathBuf,
    bool,
    Box<dyn Fn(&std::path::Path) -> bool>,
);

/// Detect the session id a CLI created after `since_ms`.
fn detect_cli_session_impl(
    kind: &str,
    cwd: Option<String>,
    since_ms: f64,
    exclude: &[String],
) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let since = since_ms as u64;
    let until = since.saturating_add(180_000);

    let (dir, recurse, matcher): SessionStoreSpec = match kind {
        "claude" => {
            let base = expand_tilde(
                &cwd.filter(|c| !c.is_empty())
                    .unwrap_or_else(|| home.clone()),
            );
            let encoded = base.replace(['/', '.'], "-");
            let project = std::path::PathBuf::from(&home)
                .join(".claude/projects")
                .join(encoded);
            (
                project,
                false,
                Box::new(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
            )
        }
        "codex" => (
            std::path::PathBuf::from(&home).join(".codex/sessions"),
            true,
            Box::new(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
        ),
        "opencode" => (
            std::path::PathBuf::from(&home).join(".local/share/opencode/storage"),
            true,
            Box::new(|p| {
                p.extension().and_then(|e| e.to_str()) == Some("json")
                    && p.file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.starts_with("ses_"))
                        .unwrap_or(false)
            }),
        ),
        _ => return None,
    };

    let mut candidates = Vec::new();
    files_in_window(&dir, since, until, recurse, &matcher, &mut candidates);
    select_session_id(kind, &mut candidates, exclude)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    command: String,
    terminal_shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    state.spawn(app, id, command, terminal_shell, cwd, rows, cols)
}

#[tauri::command]
pub fn write_session(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, SessionManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.resize(&id, rows, cols)
}

#[tauri::command]
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    state.kill(&id);
    // the ring stays through a plain exit (devices can still read the final
    // screen); an explicit kill/delete drops it
    tap_remove(&id);
    Ok(())
}

#[tauri::command]
pub fn live_sessions(state: State<'_, SessionManager>) -> Vec<String> {
    state.live_ids()
}

#[tauri::command]
pub fn detect_cli_session(
    kind: String,
    cwd: Option<String>,
    since_ms: f64,
    exclude: Vec<String>,
) -> Option<String> {
    detect_cli_session_impl(&kind, cwd, since_ms, &exclude)
}

#[cfg(test)]
mod tests {
    use super::{
        coalesce_output, derive_session_id, resolve_login_executable, select_session_id,
        session_launch_spec,
    };
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;

    #[test]
    /// Resolve a guaranteed system shell through an explicit path.
    fn resolves_absolute_terminal_shell() {
        assert_eq!(resolve_login_executable("/bin/sh").unwrap(), "/bin/sh");
    }

    #[test]
    /// Reject a missing shell instead of silently falling back to another
    /// executable.
    fn rejects_missing_terminal_shell() {
        assert!(resolve_login_executable("yaam-shell-that-does-not-exist").is_err());
    }

    #[test]
    /// A wrapped command runs through `/bin/sh -lc` with no SHELL override.
    fn builds_wrapped_command_launch_spec() {
        let (exe, args, shell) = session_launch_spec("echo hi", None).unwrap();
        assert_eq!(exe, "/bin/sh");
        assert_eq!(args, vec!["-lc".to_string(), "echo hi".to_string()]);
        assert!(shell.is_none());
    }

    #[test]
    /// A terminal shell launches directly as a login+interactive shell.
    fn builds_direct_terminal_launch_spec() {
        let (exe, args, shell) = session_launch_spec("", Some("/bin/sh")).unwrap();
        assert_eq!(exe, "/bin/sh");
        assert_eq!(args, vec!["-l".to_string(), "-i".to_string()]);
        assert_eq!(shell.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn derives_session_ids_per_cli() {
        assert_eq!(
            derive_session_id(
                "codex",
                Path::new(
                    "/x/rollout-2026-03-29T22-06-43-019d3d23-176a-7663-baaa-fdc8cef1e988.jsonl"
                )
            ),
            Some("019d3d23-176a-7663-baaa-fdc8cef1e988".to_string()),
        );
        assert_eq!(
            derive_session_id("claude", Path::new("/x/abc-123-def.jsonl")),
            Some("abc-123-def".to_string()),
        );
        assert_eq!(
            derive_session_id("opencode", Path::new("/x/ses_1a8d3093dffeV2rBjv.json")),
            Some("ses_1a8d3093dffeV2rBjv".to_string()),
        );
    }

    #[test]
    fn selects_the_earliest_unclaimed_session() {
        let mut candidates = vec![
            (30, PathBuf::from("/x/third.jsonl")),
            (10, PathBuf::from("/x/first.jsonl")),
            (20, PathBuf::from("/x/second.jsonl")),
        ];
        let excluded = vec!["first".to_string()];

        assert_eq!(
            select_session_id("claude", &mut candidates, &excluded).as_deref(),
            Some("second")
        );
    }

    #[test]
    /// When the webview keeps up, each chunk is emitted on its own — nothing to
    /// coalesce because the queue is empty by the time the emitter drains.
    fn coalesce_emits_single_chunk_when_queue_is_empty() {
        let (_tx, rx) = mpsc::sync_channel::<Vec<u8>>(4);
        let (merged, count) = coalesce_output(b"hello".to_vec(), &rx, 64 * 1024);
        assert_eq!(merged, b"hello");
        assert_eq!(count, 1);
    }

    #[test]
    /// A burst that is already queued gets merged into one buffer, in order.
    fn coalesce_merges_backed_up_chunks_in_order() {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
        tx.send(b"bb".to_vec()).unwrap();
        tx.send(b"cc".to_vec()).unwrap();
        let (merged, count) = coalesce_output(b"aa".to_vec(), &rx, 64 * 1024);
        assert_eq!(merged, b"aabbcc");
        assert_eq!(count, 3);
    }

    #[test]
    /// Coalescing stops once the buffer reaches the byte cap, leaving the rest
    /// queued for the next event (may overshoot by at most one chunk).
    fn coalesce_respects_the_byte_cap() {
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
        tx.send(vec![b'b'; 3]).unwrap();
        tx.send(vec![b'c'; 3]).unwrap();
        // cap of 4: first chunk (3) is under the cap, pull one more (→6 ≥ 4, stop)
        let (merged, count) = coalesce_output(vec![b'a'; 3], &rx, 4);
        assert_eq!(count, 2);
        assert_eq!(merged.len(), 6);
        // the third chunk is still queued
        assert_eq!(rx.recv().unwrap(), vec![b'c'; 3]);
    }

    #[test]
    fn does_not_select_an_excluded_duplicate_id() {
        let id = "019d3d23-176a-7663-baaa-fdc8cef1e988";
        let mut candidates = vec![
            (10, PathBuf::from(format!("/x/rollout-a-{id}.jsonl"))),
            (20, PathBuf::from(format!("/x/rollout-b-{id}.jsonl"))),
        ];

        assert_eq!(
            select_session_id("codex", &mut candidates, &[id.to_string()]),
            None
        );
    }
}
