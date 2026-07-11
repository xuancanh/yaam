//! stdio MCP transport: spawn a local MCP server process and exchange
//! newline-delimited JSON-RPC over its stdin/stdout. The frontend MCP client
//! (core/mcp.ts) speaks the protocol; this module only moves lines and
//! matches response ids so a request can await its own reply.
use crate::util::expand_tilde;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver};
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
#[derive(Clone, Default)]
pub struct McpManager(Arc<Mutex<HashMap<String, Arc<Mutex<Proc>>>>>);

const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUEUED_LINES: usize = 256;

/// Read one newline-delimited record without ever retaining more than `max`
/// bytes. Oversized records are fully drained so the child cannot deadlock its
/// pipe; callers can reject them and continue with the next record.
fn read_bounded_line(reader: &mut impl BufRead, max: usize) -> std::io::Result<Option<(String, bool)>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() && !oversized {
                Ok(None)
            } else {
                Ok(Some((String::from_utf8_lossy(&bytes).into_owned(), oversized)))
            };
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if !oversized {
            let remaining = max.saturating_sub(bytes.len());
            bytes.extend_from_slice(&available[..take.min(remaining)]);
            if take > remaining { oversized = true; }
        }
        reader.consume(take);
        if newline.is_some() {
            while matches!(bytes.last(), Some(b'\n' | b'\r')) { bytes.pop(); }
            return Ok(Some((String::from_utf8_lossy(&bytes).into_owned(), oversized)));
        }
    }
}

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
    if id.is_empty() || id.len() > 256 || command.trim().is_empty() {
        return Err("invalid MCP server id or command".to_string());
    }
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

    let (tx, rx) = sync_channel::<String>(MAX_QUEUED_LINES);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some((line, oversized))) = read_bounded_line(&mut reader, MAX_LINE_BYTES) {
            if oversized {
                log::warn!("MCP server emitted an oversized stdout record; discarded");
            } else if tx.send(line).is_err() {
                break
            }
        }
    });
    if let Some(err) = stderr {
        let label = id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(err);
            while let Ok(Some((line, oversized))) = read_bounded_line(&mut reader, 64 * 1024) {
                if oversized { log::warn!("[mcp:{label}] oversized stderr line discarded"); }
                else { log::info!("[mcp:{label}] {line}"); }
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
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("MCP request exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
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
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("MCP notification exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
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
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move ||
        request_impl(&manager, &id, payload, timeout_ms.unwrap_or(60_000)))
        .await
        .map_err(|e| e.to_string())?
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
    use super::{read_bounded_line, request_impl, start_impl, stop_impl, McpManager, MAX_PAYLOAD_BYTES};
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

    #[test]
    fn bounds_protocol_lines_and_request_payloads() {
        let mut input = std::io::BufReader::new(std::io::Cursor::new(b"123456789\nok\n"));
        let (first, oversized) = read_bounded_line(&mut input, 4).unwrap().unwrap();
        assert_eq!(first, "1234");
        assert!(oversized);
        assert_eq!(read_bounded_line(&mut input, 4).unwrap().unwrap(), ("ok".into(), false));

        let mgr = McpManager::default();
        let err = request_impl(&mgr, "missing", "x".repeat(MAX_PAYLOAD_BYTES + 1), 1_000)
            .unwrap_err();
        assert!(err.contains("exceeds"));
    }
}
