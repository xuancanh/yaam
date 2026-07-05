//! Composition root: register domain-managed state and command boundaries,
//! then run the Tauri app. Each domain owns its command handlers and logic.
mod domains;
mod setup;
mod util;

use domains::bedrock::BedrockState;
use domains::mcp::McpManager;
use domains::remote::RemoteManager;
use domains::search::ChatSearchState;
use domains::session::SessionManager;
use domains::watch::WatchManager;
use tauri::{Emitter, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        // Give the webview a chance to flush persisted state before teardown:
        // veto the OS close, tell the frontend, and let it destroy the window
        // once its flush settles (it applies its own timeout so a stuck flush
        // can't wedge the close). destroy() bypasses this event, so no loop.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .manage(SessionManager::default())
        .manage(BedrockState::default())
        .manage(ChatSearchState::default())
        .manage(McpManager::default())
        .manage(RemoteManager::default())
        .manage(WatchManager::default())
        .invoke_handler(tauri::generate_handler![
            domains::session::spawn_session,
            domains::session::write_session,
            domains::session::resize_session,
            domains::session::kill_session,
            domains::session::live_sessions,
            domains::session::detect_cli_session,
            domains::git::git_diff,
            domains::git::git_status,
            domains::git::git_file_diff,
            domains::git::git_file_diff_side,
            domains::git::git_stage,
            domains::git::git_unstage,
            domains::git::git_commit,
            domains::fs::list_dir,
            domains::fs::read_text_file,
            domains::fs::read_text_range,
            domains::fs::read_file_b64,
            domains::fs::write_text_file,
            domains::fs::run_credential_command,
            domains::fs::exec_command,
            domains::state::save_state,
            domains::state::load_state,
            domains::state::load_state_backup,
            domains::state::save_partition,
            domains::state::load_partition,
            domains::state::save_session,
            domains::state::remove_session,
            domains::state::load_sessions,
            domains::worktree::worktree_create,
            domains::worktree::worktree_diff,
            domains::worktree::worktree_merge,
            domains::worktree::worktree_remove,
            domains::mcp::mcp_stdio_start,
            domains::mcp::mcp_stdio_request,
            domains::mcp::mcp_stdio_notify,
            domains::mcp::mcp_stdio_stop,
            domains::icons::file_icon,
            domains::remote::remote_start,
            domains::remote::remote_stop,
            domains::remote::remote_publish,
            domains::remote::remote_take_decisions,
            domains::search::chat_search_reindex,
            domains::search::chat_search_upsert,
            domains::search::chat_search_remove,
            domains::search::chat_search,
            domains::bedrock::bedrock_invoke,
            domains::secrets::secret_set,
            domains::secrets::secret_get,
            domains::secrets::secret_delete,
            domains::watch::watch_dir,
            domains::watch::unwatch_dir,
        ])
        .setup(|app| setup::init(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
