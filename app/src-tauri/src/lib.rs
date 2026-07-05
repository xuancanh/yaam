//! Composition root: register domain-managed state and command boundaries,
//! then run the Tauri app. Each domain owns its command handlers and logic.
mod domains;
mod setup;
mod util;

use domains::bedrock::BedrockState;
use domains::search::ChatSearchState;
use domains::session::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(SessionManager::default())
        .manage(BedrockState::default())
        .manage(ChatSearchState::default())
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
            domains::fs::list_dir,
            domains::fs::read_text_file,
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
            domains::search::chat_search_reindex,
            domains::search::chat_search,
            domains::bedrock::bedrock_invoke,
            domains::secrets::secret_set,
            domains::secrets::secret_get,
            domains::secrets::secret_delete,
        ])
        .setup(|app| setup::init(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
