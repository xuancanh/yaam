//! stdio MCP transport: spawn a local MCP server process and exchange
//! newline-delimited JSON-RPC over its stdin/stdout. The frontend MCP client
//! (core/mcp.ts) speaks the protocol; this module only moves lines and
//! matches response ids so a request can await its own reply.
use crate::util::expand_tilde;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Requests waiting on a reply, keyed by their JSON-RPC id (as JSON text).
type Waiters = Arc<Mutex<HashMap<String, SyncSender<String>>>>;

/// One server process. Requests no longer hold a per-server lock while they
/// wait: the reader thread routes each reply to the request with that id, so
/// calls run concurrently and a `notifications/cancelled` can reach the server
/// while the request it cancels is still pending (it used to queue behind it,
/// blocking an async worker, which made cancellation useless).
struct Proc {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    waiters: Waiters,
}

impl Drop for Proc {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            // the whole group: an `npx`/`uvx` launcher's node or python
            // grandchild otherwise outlives the server (the child is not
            // reaped yet, so its pid and group id can't have been reused)
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Live stdio MCP server processes by server id.
#[derive(Clone, Default)]
pub struct McpManager(Arc<Mutex<HashMap<String, Arc<Proc>>>>);

const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

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

fn get_proc(mgr: &McpManager, id: &str) -> Result<Arc<Proc>, String> {
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
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
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

    let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
    let route = waiters.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some((line, oversized))) = read_bounded_line(&mut reader, MAX_LINE_BYTES) {
            if oversized {
                log::warn!("MCP server emitted an oversized stdout record; discarded");
                continue;
            }
            // server notifications and reverse requests carry no id we are
            // waiting on and are skipped (v1: roots/list etc. not serviced)
            let Some(key) = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .filter(|v| v.get("method").is_none())
                .and_then(|v| v.get("id").map(|id| id.to_string()))
            else {
                continue;
            };
            if let Some(tx) = route.lock().unwrap().remove(&key) {
                let _ = tx.try_send(line);
            }
        }
        // EOF: dropping the remaining senders wakes their requests at once
        route.lock().unwrap().clear();
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
        .insert(id, Arc::new(Proc { child: Mutex::new(child), stdin: Mutex::new(stdin), waiters }));
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
    let key = want_id.to_string();
    let (tx, rx) = sync_channel::<String>(1);
    let waiters = {
        let proc = get_proc(mgr, id)?;
        // register before writing, so a fast reply can't arrive unrouted
        proc.waiters.lock().unwrap().insert(key.clone(), tx);
        let written = write_line(&proc, &payload);
        if let Err(e) = written {
            proc.waiters.lock().unwrap().remove(&key);
            return Err(e);
        }
        // only the waiter map is kept: holding the process here would keep
        // a stopped server alive until this request timed out
        proc.waiters.clone()
    };
    let res = rx
        .recv_timeout(Duration::from_millis(timeout_ms.clamp(1_000, 120_000)))
        .map_err(|_| "MCP server did not answer (timeout or process exited)".to_string());
    waiters.lock().unwrap().remove(&key);
    res
}

fn write_line(proc: &Proc, payload: &str) -> Result<(), String> {
    let mut stdin = proc.stdin.lock().map_err(|_| "server stdin poisoned")?;
    stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("server stdin closed: {e}"))
}

fn notify_impl(mgr: &McpManager, id: &str, payload: String) -> Result<(), String> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!("MCP notification exceeds {MAX_PAYLOAD_BYTES} bytes"));
    }
    write_line(&*get_proc(mgr, id)?, &payload)
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
    let manager = state.inner().clone();
    crate::util::blocking(move || start_impl(&manager, id, command, args, env, cwd)).await
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
    // a pipe write can block (a server not reading stdin): never on an
    // async worker
    let manager = state.inner().clone();
    crate::util::blocking(move || notify_impl(&manager, &id, payload)).await
}

#[tauri::command]
pub async fn mcp_stdio_stop(state: tauri::State<'_, McpManager>, id: String) -> Result<(), String> {
    let manager = state.inner().clone();
    crate::util::blocking(move || { stop_impl(&manager, &id); Ok(()) }).await
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

    #[test]
    fn concurrent_requests_each_get_their_own_reply() {
        let mgr = McpManager::default();
        // answers in reverse order: two reads, then reply to id 2 before id 1
        start_impl(
            &mgr,
            "t2".into(),
            "/bin/sh".into(),
            vec![
                "-c".into(),
                r#"read a; read b; echo '{"jsonrpc":"2.0","id":2,"result":"two"}'; echo '{"jsonrpc":"2.0","id":1,"result":"one"}'"#.into(),
            ],
            HashMap::new(),
            None,
        )
        .unwrap();
        let m1 = mgr.clone();
        let first = std::thread::spawn(move || request_impl(&m1, "t2", r#"{"jsonrpc":"2.0","id":1,"method":"a"}"#.into(), 5_000));
        std::thread::sleep(std::time::Duration::from_millis(50));
        let second = request_impl(&mgr, "t2", r#"{"jsonrpc":"2.0","id":2,"method":"b"}"#.into(), 5_000).unwrap();
        assert!(second.contains("two"));
        assert!(first.join().unwrap().unwrap().contains("one"));
        stop_impl(&mgr, "t2");
    }
}

