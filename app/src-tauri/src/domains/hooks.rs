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
