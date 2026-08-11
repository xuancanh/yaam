//! Agent Client Protocol (ACP) peer. ACP agents (`kiro-cli acp`,
//! `gemini --acp`, the Claude adapter) are plain child processes speaking
//! newline-delimited JSON-RPC 2.0 over stdio — no PTY. YAAM is the CLIENT:
//! it drives the agent (initialize → session/new → session/prompt) and also
//! answers the agent's own requests (session/request_permission). The protocol
//! is small enough that the framing lives here instead of an SDK dependency.
//!
//! Flow: `acp_start` spawns the agent and runs the handshake; every inbound
//! message the frontend cares about is forwarded as an `acp-event`
//! ({agent, kind: ready|update|permission|response|error, ...}). Client
//! methods we did not advertise (fs/*, terminal/*) are auto-declined with
//! method-not-found. Child exit emits the same `session-exit` event PTY
//! sessions use, so the whole exit pipeline (watchers, status) applies as-is.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct AcpManager {
    sessions: Mutex<HashMap<String, AcpHandle>>,
}

struct AcpHandle {
    child: Arc<Mutex<Child>>,
    writer: std::sync::mpsc::Sender<String>,
    session_id: Arc<Mutex<Option<String>>>,
    next_id: Arc<AtomicI64>,
}

/// ids reserved for the handshake; user requests start above them
const ID_INITIALIZE: i64 = 0;
const ID_NEW_SESSION: i64 = 1;
const ID_FIRST_FREE: i64 = 2;

fn rpc(method: &str, id: Option<i64>, params: serde_json::Value) -> String {
    let mut v = serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
    if let Some(id) = id {
        v["id"] = serde_json::json!(id);
    }
    v.to_string()
}

fn initialize_line() -> String {
    // no fs/terminal capabilities: the agent must fall back to its own file
    // and process access, so nothing needs implementing client-side yet
    rpc(
        "initialize",
        Some(ID_INITIALIZE),
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "yaam", "version": env!("CARGO_PKG_VERSION") }
        }),
    )
}

fn new_session_line(cwd: &str) -> String {
    rpc(
        "session/new",
        Some(ID_NEW_SESSION),
        serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
    )
}

/// What one inbound line means to the peer.
enum Inbound {
    /// agent → client request (has method + id)
    Request { id: serde_json::Value, method: String, params: serde_json::Value },
    /// agent notification (method, no id)
    Notification { method: String, params: serde_json::Value },
    /// response to one of our requests
    Response { id: i64, result: Option<serde_json::Value>, error: Option<serde_json::Value> },
    Ignored,
}

fn classify(v: &serde_json::Value) -> Inbound {
    let method = v.get("method").and_then(|m| m.as_str());
    let id = v.get("id");
    match (method, id) {
        (Some(m), Some(id)) => Inbound::Request {
            id: id.clone(),
            method: m.to_string(),
            params: v.get("params").cloned().unwrap_or(serde_json::Value::Null),
        },
        (Some(m), None) => Inbound::Notification {
            method: m.to_string(),
            params: v.get("params").cloned().unwrap_or(serde_json::Value::Null),
        },
        (None, Some(id)) => match id.as_i64() {
            Some(id) => Inbound::Response {
                id,
                result: v.get("result").cloned(),
                error: v.get("error").cloned(),
            },
            None => Inbound::Ignored,
        },
        _ => Inbound::Ignored,
    }
}

fn emit_event(app: &AppHandle, agent: &str, mut payload: serde_json::Value) {
    payload["agent"] = serde_json::json!(agent);
    let _ = app.emit("acp-event", payload);
}

#[allow(clippy::too_many_lines)]
fn reader_loop(
    app: AppHandle,
    agent: String,
    stdout: std::process::ChildStdout,
    writer: std::sync::mpsc::Sender<String>,
    session_id: Arc<Mutex<Option<String>>>,
    cwd: String,
) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        match classify(&v) {
            Inbound::Response { id: ID_INITIALIZE, error, .. } => {
                if let Some(err) = error {
                    emit_event(&app, &agent, serde_json::json!({ "kind": "error", "stage": "initialize", "error": err }));
                } else {
                    let _ = writer.send(new_session_line(&cwd));
                }
            }
            Inbound::Response { id: ID_NEW_SESSION, result, error } => {
                if let Some(err) = error {
                    emit_event(&app, &agent, serde_json::json!({ "kind": "error", "stage": "session/new", "error": err }));
                } else {
                    let sid = result
                        .as_ref()
                        .and_then(|r| r.get("sessionId"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Ok(mut slot) = session_id.lock() {
                        *slot = Some(sid.clone());
                    }
                    emit_event(&app, &agent, serde_json::json!({ "kind": "ready", "sessionId": sid }));
                }
            }
            Inbound::Response { id, result, error } => {
                emit_event(
                    &app,
                    &agent,
                    serde_json::json!({ "kind": "response", "id": id, "result": result, "error": error }),
                );
            }
            Inbound::Request { id, method, params } => {
                if method == "session/request_permission" {
                    emit_event(
                        &app,
                        &agent,
                        serde_json::json!({ "kind": "permission", "requestId": id, "params": params }),
                    );
                } else {
                    // capabilities we did not advertise — decline politely
                    let _ = writer.send(
                        serde_json::json!({
                            "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32601, "message": format!("client method not supported: {method}") }
                        })
                        .to_string(),
                    );
                }
            }
            Inbound::Notification { method, params } => {
                if method == "session/update" {
                    emit_event(&app, &agent, serde_json::json!({ "kind": "update", "params": params }));
                }
                // other notifications (agent extensions like _kiro.dev/*) are ignored
            }
            Inbound::Ignored => {}
        }
    }
}

/// Spawn an ACP agent for one YAAM session and run the handshake. `command`
/// runs through the user's shell (login + -c) so PATH matches their terminal.
#[tauri::command]
pub fn acp_start(
    app: AppHandle,
    state: State<AcpManager>,
    agent: String,
    command: String,
    cwd: String,
    shell: Option<String>,
) -> Result<(), String> {
    let sh = shell.filter(|s| !s.is_empty()).unwrap_or_else(|| "zsh".to_string());
    let mut cmd = Command::new(&sh);
    cmd.args(["-lc", &format!("exec {command}")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd.spawn().map_err(|e| format!("acp spawn failed: {e}"))?;
    let stdin = child.stdin.take().ok_or("acp stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("acp stdout unavailable")?;
    if let Some(stderr) = child.stderr.take() {
        // drain stderr so the agent can't block on a full pipe; log at debug
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::debug!("acp stderr: {line}");
            }
        });
    }

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(line) = rx.recv() {
            if stdin.write_all(line.as_bytes()).is_err() || stdin.write_all(b"\n").is_err() {
                break;
            }
            let _ = stdin.flush();
        }
    });

    let session_id = Arc::new(Mutex::new(None));
    let child = Arc::new(Mutex::new(child));
    let handle = AcpHandle {
        child: child.clone(),
        writer: tx.clone(),
        session_id: session_id.clone(),
        next_id: Arc::new(AtomicI64::new(ID_FIRST_FREE)),
    };
    {
        let mut sessions = state.sessions.lock().map_err(|_| "acp lock poisoned".to_string())?;
        if let Some(old) = sessions.insert(agent.clone(), handle) {
            let _ = old.child.lock().map(|mut c| c.kill());
        }
    }

    let _ = tx.send(initialize_line());
    {
        let app = app.clone();
        let agent = agent.clone();
        let cwd = cwd.clone();
        std::thread::spawn(move || reader_loop(app, agent, stdout, tx, session_id, cwd));
    }
    // reaper: the frontend's whole exit pipeline listens for session-exit
    std::thread::spawn(move || {
        let code = loop {
            {
                let mut guard = match child.lock() {
                    Ok(g) => g,
                    Err(_) => break None,
                };
                match guard.try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        let _ = app.emit("session-exit", serde_json::json!({ "id": agent, "code": code }));
    });
    Ok(())
}

/// Send one prompt turn. The response streams back as update events, then a
/// `response` event carrying stopReason.
#[tauri::command]
pub fn acp_prompt(state: State<AcpManager>, agent: String, text: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "acp lock poisoned".to_string())?;
    let handle = sessions.get(&agent).ok_or("no acp session")?;
    let sid = handle
        .session_id
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or("acp session not ready yet")?;
    let id = handle.next_id.fetch_add(1, Ordering::Relaxed);
    handle
        .writer
        .send(rpc(
            "session/prompt",
            Some(id),
            serde_json::json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": text }] }),
        ))
        .map_err(|_| "acp writer closed".to_string())
}

/// Cancel the in-flight turn (the agent still answers the prompt with
/// stopReason: cancelled).
#[tauri::command]
pub fn acp_cancel(state: State<AcpManager>, agent: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "acp lock poisoned".to_string())?;
    let handle = sessions.get(&agent).ok_or("no acp session")?;
    let sid = handle
        .session_id
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or("acp session not ready yet")?;
    handle
        .writer
        .send(rpc("session/cancel", None, serde_json::json!({ "sessionId": sid })))
        .map_err(|_| "acp writer closed".to_string())
}

/// Answer a pending session/request_permission. `option_id` selects an
/// option; None responds cancelled.
#[tauri::command]
pub fn acp_respond_permission(
    state: State<AcpManager>,
    agent: String,
    request_id: serde_json::Value,
    option_id: Option<String>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "acp lock poisoned".to_string())?;
    let handle = sessions.get(&agent).ok_or("no acp session")?;
    let outcome = match option_id {
        Some(oid) => serde_json::json!({ "outcome": { "outcome": "selected", "optionId": oid } }),
        None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
    };
    handle
        .writer
        .send(serde_json::json!({ "jsonrpc": "2.0", "id": request_id, "result": outcome }).to_string())
        .map_err(|_| "acp writer closed".to_string())
}

/// Kill the agent process and forget the session.
#[tauri::command]
pub fn acp_stop(state: State<AcpManager>, agent: String) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(handle) = sessions.remove(&agent) {
            let _ = handle.child.lock().map(|mut c| c.kill());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_lines_follow_the_v1_shapes() {
        let init: serde_json::Value = serde_json::from_str(&initialize_line()).unwrap();
        assert_eq!(init["method"], "initialize");
        assert_eq!(init["params"]["protocolVersion"], 1);
        assert_eq!(init["id"], 0);
        let new: serde_json::Value = serde_json::from_str(&new_session_line("/repo")).unwrap();
        assert_eq!(new["method"], "session/new");
        assert_eq!(new["params"]["cwd"], "/repo");
        assert_eq!(new["params"]["mcpServers"], serde_json::json!([]));
    }

    #[test]
    fn classify_separates_requests_notifications_and_responses() {
        let req = serde_json::json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{}});
        assert!(matches!(classify(&req), Inbound::Request { method, .. } if method == "session/request_permission"));
        let note = serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{}});
        assert!(matches!(classify(&note), Inbound::Notification { method, .. } if method == "session/update"));
        let resp = serde_json::json!({"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}});
        assert!(matches!(classify(&resp), Inbound::Response { id: 2, .. }));
        assert!(matches!(classify(&serde_json::json!({"jsonrpc":"2.0"})), Inbound::Ignored));
    }
}
