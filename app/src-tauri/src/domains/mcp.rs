//! stdio MCP transport: spawn a local MCP server process and exchange
//! newline-delimited JSON-RPC over its stdin/stdout. The frontend MCP client
//! (core/mcp.ts) speaks the protocol; this module only moves lines and
//! matches response ids so a request can await its own reply.
use crate::util::expand_tilde;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Proc {
    child: Child,
    stdin: ChildStdin,
    /// complete stdout lines from the reader thread
    rx: Receiver<String>,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Live stdio MCP server processes by server id. Each process is behind its
/// own mutex so one slow request doesn't block other servers.
#[derive(Default)]
pub struct McpManager(Mutex<HashMap<String, Arc<Mutex<Proc>>>>);

fn get_proc(mgr: &McpManager, id: &str) -> Result<Arc<Mutex<Proc>>, String> {
    mgr.0
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| format!("stdio MCP server {id} is not running"))
}

fn start_impl(
    mgr: &McpManager,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut c = Command::new(&command);
    c.args(&args)
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        c.current_dir(expand_tilde(&dir));
    }
    // GUI apps on macOS don't inherit the login-shell PATH; make sure the
    // usual tool locations are reachable for `npx` / `uvx` style launchers.
    if let Ok(path) = std::env::var("PATH") {
        let home = std::env::var("HOME").unwrap_or_default();
        c.env(
            "PATH",
            format!("{path}:/usr/local/bin:/opt/homebrew/bin:{home}/.local/bin:{home}/.cargo/bin"),
        );
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("failed to start {command}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take();

    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    if let Some(err) = stderr {
        let label = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::info!("[mcp:{label}] {line}");
            }
        });
    }

    // replacing an existing entry drops (and thereby kills) the old process
    mgr.0
        .lock()
        .unwrap()
        .insert(id, Arc::new(Mutex::new(Proc { child, stdin, rx })));
    Ok(())
}

/// Send one JSON-RPC request line and wait for the line answering our id.
/// Server-initiated notifications/requests that arrive in between are skipped
/// (v1: we don't service reverse requests like roots/list).
fn request_impl(mgr: &McpManager, id: &str, payload: String, timeout_ms: u64) -> Result<String, String> {
    let want_id = serde_json::from_str::<serde_json::Value>(&payload)
        .ok()
        .and_then(|v| v.get("id").cloned())
        .ok_or("payload has no JSON-RPC id")?;
    let proc = get_proc(mgr, id)?;
    let mut p = proc.lock().map_err(|_| "server mutex poisoned")?;
    p.stdin
        .write_all(payload.as_bytes())
        .and_then(|_| p.stdin.write_all(b"\n"))
        .and_then(|_| p.stdin.flush())
        .map_err(|e| format!("server stdin closed: {e}"))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(1_000, 120_000));
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("timed out waiting for the MCP server response")?;
        let line = p.rx.recv_timeout(remaining).map_err(|_| {
            "MCP server did not answer (timeout or process exited)".to_string()
        })?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v.get("id") == Some(&want_id) {
                return Ok(line);
            }
        }
    }
}

fn notify_impl(mgr: &McpManager, id: &str, payload: String) -> Result<(), String> {
    let proc = get_proc(mgr, id)?;
    let mut p = proc.lock().map_err(|_| "server mutex poisoned")?;
    p.stdin
        .write_all(payload.as_bytes())
        .and_then(|_| p.stdin.write_all(b"\n"))
        .and_then(|_| p.stdin.flush())
        .map_err(|e| format!("server stdin closed: {e}"))
}

fn stop_impl(mgr: &McpManager, id: &str) {
    // dropping the Proc kills the child
    mgr.0.lock().unwrap().remove(id);
}

#[tauri::command]
pub async fn mcp_stdio_start(
    state: tauri::State<'_, McpManager>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<(), String> {
    start_impl(&state, id, command, args, env, cwd)
}

#[tauri::command]
pub async fn mcp_stdio_request(
    state: tauri::State<'_, McpManager>,
    id: String,
    payload: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    // request_impl blocks while waiting for the child's reply; async commands
    // run on Tauri's pooled runtime, and the wait is bounded by the timeout.
    request_impl(&state, &id, payload, timeout_ms.unwrap_or(60_000))
}

#[tauri::command]
pub async fn mcp_stdio_notify(
    state: tauri::State<'_, McpManager>,
    id: String,
    payload: String,
) -> Result<(), String> {
    notify_impl(&state, &id, payload)
}

#[tauri::command]
pub async fn mcp_stdio_stop(state: tauri::State<'_, McpManager>, id: String) -> Result<(), String> {
    stop_impl(&state, &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{request_impl, start_impl, stop_impl, McpManager};
    use std::collections::HashMap;

    #[test]
    fn round_trips_a_request_and_skips_interleaved_notifications() {
        let mgr = McpManager::default();
        // a fake MCP server: emits a notification first, then echoes one reply
        start_impl(
            &mgr,
            "t1".into(),
            "/bin/sh".into(),
            vec![
                "-c".into(),
                r#"read line; echo '{"jsonrpc":"2.0","method":"notifications/noise"}'; echo '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}'"#.into(),
            ],
            HashMap::new(),
            None,
        )
        .unwrap();
        let res = request_impl(&mgr, "t1", r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#.into(), 5_000).unwrap();
        assert!(res.contains(r#""ok":true"#));
        stop_impl(&mgr, "t1");
    }

    #[test]
    fn reports_a_missing_server() {
        let mgr = McpManager::default();
        let err =
            request_impl(&mgr, "nope", r#"{"id":1}"#.into(), 1_000).unwrap_err();
        assert!(err.contains("not running"));
    }
}
