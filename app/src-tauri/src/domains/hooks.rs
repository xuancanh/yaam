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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State as TauriState};

use super::remote::rand_token;

#[derive(Default)]
pub struct HookListener {
    info: Mutex<Option<HookInfo>>,
}

#[derive(Clone, Serialize)]
pub struct HookInfo {
    pub port: u16,
    pub token: String,
}

struct Shared {
    app: AppHandle,
    token: String,
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
        .with_state(shared)
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
    let shared = Arc::new(Shared { app, token: token.clone() });
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
