//! Local HTTP listener for coding-agent lifecycle hooks. Claude Code sessions
//! launched by YAAM get `--settings` http hooks pointing here (see the claude
//! adapter on the TS side); each hook POST is forwarded to the frontend as an
//! `agent-hook` Tauri event and acknowledged with an empty JSON object, so the
//! CLI's behavior never changes — this is sensing, not control. Loopback only,
//! and every request must carry the per-run bearer token minted at start.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State as TauriState};

use super::remote::rand_token;

#[derive(Default)]
pub struct HookListener {
    info: Mutex<Option<HookInfo>>,
    /// tools/call round-trips awaiting the frontend's mcp_serve_respond
    pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    call_seq: Arc<AtomicU64>,
}

#[derive(Clone, Serialize)]
pub struct HookInfo {
    pub port: u16,
    pub token: String,
}

struct Shared {
    app: AppHandle,
    token: String,
    pending: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    call_seq: Arc<AtomicU64>,
}

/// The manager tools spawned sessions may call (MCP tools/list).
pub fn mcp_tool_defs() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "report_status",
            "description": "Report your live status to YAAM, the session manager: what task you are on, what you are doing right now, and what comes next. Call this after completing a milestone, when you change approach, and when you finish. If you are blocked on the user, say so in action_needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "one line: the goal you are working toward" },
                    "summary": { "type": "string", "description": "one line: what you are doing right now" },
                    "next_action": { "type": "string", "description": "one line: what you will do next (or 'done')" },
                    "action_needed": { "type": "string", "description": "set ONLY when you are blocked on the user; one line describing what you need" }
                }
            }
        },
        {
            "name": "get_task",
            "description": "Fetch the YAAM board task linked to this session: title, description, acceptance criteria, and column. Use it to re-read your contract before claiming completion.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

fn rpc_result(id: &serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &serde_json::Value, code: i64, message: &str) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Streamable-HTTP MCP endpoint for spawned sessions. initialize and
/// tools/list are answered here; tools/call round-trips to the frontend
/// (which owns tasks/agents state) via an `mcp-serve-call` event answered by
/// the mcp_serve_respond command.
async fn mcp(
    State(shared): State<Arc<Shared>>,
    Query(q): Query<HookQuery>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if q.token != shared.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let Some(id) = req.get("id").cloned() else {
        // notifications (notifications/initialized, …) need no body
        return Err(StatusCode::ACCEPTED);
    };
    match method {
        "initialize" => {
            let requested = req
                .pointer("/params/protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-06-18");
            Ok(Json(rpc_result(&id, serde_json::json!({
                "protocolVersion": requested,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "yaam", "version": env!("CARGO_PKG_VERSION") }
            }))))
        }
        "ping" => Ok(Json(rpc_result(&id, serde_json::json!({})))),
        "tools/list" => Ok(Json(rpc_result(&id, serde_json::json!({ "tools": mcp_tool_defs() })))),
        "tools/call" => {
            let call_id = shared.call_seq.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
            if let Ok(mut pending) = shared.pending.lock() {
                pending.insert(call_id, tx);
            }
            let _ = shared.app.emit(
                "mcp-serve-call",
                serde_json::json!({
                    "callId": call_id,
                    "agent": q.agent,
                    "name": req.pointer("/params/name").cloned().unwrap_or(serde_json::Value::Null),
                    "arguments": req.pointer("/params/arguments").cloned().unwrap_or(serde_json::json!({})),
                }),
            );
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), rx).await;
            if let Ok(mut pending) = shared.pending.lock() {
                pending.remove(&call_id);
            }
            match outcome {
                Ok(Ok(result)) => Ok(Json(rpc_result(&id, result))),
                _ => Ok(Json(rpc_error(&id, -32000, "yaam did not answer the tool call in time"))),
            }
        }
        _ => Ok(Json(rpc_error(&id, -32601, "method not found"))),
    }
}

#[derive(Deserialize)]
struct HookQuery {
    token: String,
    /// YAAM's own session id, embedded in the hook URL at launch so events map
    /// to a session without relying on the CLI's id
    agent: Option<String>,
}

async fn hook(
    State(shared): State<Arc<Shared>>,
    Query(q): Query<HookQuery>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if q.token != shared.token {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let _ = shared.app.emit(
        "agent-hook",
        serde_json::json!({ "agent": q.agent, "payload": payload }),
    );
    // empty object = acknowledge without a decision; the CLI proceeds normally
    Ok(Json(serde_json::json!({})))
}

fn router(shared: Arc<Shared>) -> Router {
    Router::new()
        .route("/hook", post(hook))
        .route("/mcp", post(mcp))
        .with_state(shared)
}

/// Complete one pending tools/call round-trip from the frontend. `result` is
/// the MCP tool result ({content: [...], isError?}).
#[tauri::command]
pub fn mcp_serve_respond(
    state: TauriState<HookListener>,
    call_id: u64,
    result: serde_json::Value,
) -> Result<(), String> {
    let tx = state
        .pending
        .lock()
        .map_err(|_| "mcp pending lock poisoned".to_string())?
        .remove(&call_id);
    match tx {
        Some(tx) => { let _ = tx.send(result); Ok(()) }
        None => Err("no pending mcp call with that id".to_string()),
    }
}

/// Kiro's hooks are configured as JSON files, not launch flags: this builds
/// the bridge file that forwards every lifecycle event's stdin JSON to the
/// loopback listener. `$YAAM_SESSION` (exported into YAAM-launched sessions)
/// identifies the exact session; curl failures are swallowed (`|| true`) so a
/// closed YAAM never blocks the CLI, and blocking triggers stay unaffected.
pub fn kiro_hooks_json(url: &str) -> String {
    let triggers = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
    let hooks: Vec<serde_json::Value> = triggers
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": format!("yaam-{}", t.to_lowercase()),
                "trigger": t,
                "action": {
                    "type": "command",
                    "command": format!(
                        "curl -fsS -m 3 -X POST \"{url}&agent=$YAAM_SESSION\" -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true"
                    )
                }
            })
        })
        .collect();
    serde_json::json!({ "version": "v1", "hooks": hooks }).to_string()
}

/// Write (or refresh) the global Kiro hook bridge at ~/.kiro/hooks/. Called on
/// each Kiro launch so the file always carries the current run's port+token;
/// a stale file from a previous run fails fast and silently.
#[tauri::command]
pub fn kiro_hooks_install(url: String) -> Result<(), String> {
    // the URL lands inside a shell command in a config file — accept only our
    // own loopback listener so this can never be pointed elsewhere
    if !url.starts_with("http://127.0.0.1:") || url.contains(['"', '\\', '$', '`']) {
        return Err("refusing to install hooks for a non-local url".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let dir = std::path::PathBuf::from(&home).join(".kiro/hooks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("yaam-bridge.json"), kiro_hooks_json(&url)).map_err(|e| e.to_string())
}

/// Return the listener's address, starting it on first use. The server lives
/// for the app's lifetime; a fresh token is minted per app run, so hook URLs
/// from a previous run stop working (their POSTs fail fast and the CLI moves on).
#[tauri::command]
pub fn hooks_info(app: AppHandle, state: TauriState<HookListener>) -> Result<HookInfo, String> {
    let mut slot = state.info.lock().map_err(|_| "hook listener lock poisoned".to_string())?;
    if let Some(info) = slot.as_ref() {
        return Ok(info.clone());
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("could not bind hook listener: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = rand_token(32)?;
    let shared = Arc::new(Shared {
        app,
        token: token.clone(),
        pending: state.pending.clone(),
        call_seq: state.call_seq.clone(),
    });
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("hook listener runtime failed: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => l,
                Err(e) => {
                    log::error!("hook listener socket failed: {e}");
                    return;
                }
            };
            if let Err(e) = axum::serve(listener, router(shared)).await {
                log::error!("hook listener stopped: {e}");
            }
        });
    });
    let info = HookInfo { port, token };
    *slot = Some(info.clone());
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tools_expose_status_reporting_and_the_task_contract() {
        let defs = mcp_tool_defs();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["report_status", "get_task"]);
        for t in defs.as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().len() > 20);
        }
    }

    #[test]
    fn kiro_bridge_covers_lifecycle_triggers_and_forwards_stdin() {
        let json = kiro_hooks_json("http://127.0.0.1:4242/hook?token=t0k");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["version"], "v1");
        let hooks = v["hooks"].as_array().unwrap();
        let triggers: Vec<&str> = hooks.iter().map(|h| h["trigger"].as_str().unwrap()).collect();
        assert_eq!(triggers, ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
        let cmd = hooks[0]["action"]["command"].as_str().unwrap();
        assert!(cmd.contains("http://127.0.0.1:4242/hook?token=t0k&agent=$YAAM_SESSION"));
        assert!(cmd.contains("--data-binary @-"));
        assert!(cmd.ends_with("|| true"));
    }
}
