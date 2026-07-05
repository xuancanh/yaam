//! Composition root: declare the layered modules, register managed state and
//! the command surface, and run the Tauri app. Domain logic lives in `core`;
//! the IPC handlers live in `commands`; one-time startup lives in `setup`.
mod commands;
mod core;
mod setup;

use core::bedrock::BedrockState;
use core::pty::SessionManager;
use core::search::ChatSearchState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(SessionManager::default())
        .manage(BedrockState::default())
        .manage(ChatSearchState::default())
        .invoke_handler(tauri::generate_handler![
            commands::session::spawn_session,
            commands::session::write_session,
            commands::session::resize_session,
            commands::session::kill_session,
            commands::session::live_sessions,
            commands::session::detect_cli_session,
            commands::git::git_diff,
            commands::git::git_status,
            commands::git::git_file_diff,
            commands::fs::list_dir,
            commands::fs::read_text_file,
            commands::fs::write_text_file,
            commands::fs::run_credential_command,
            commands::fs::exec_command,
            commands::state::save_state,
            commands::state::load_state,
            commands::state::load_state_backup,
            commands::state::save_partition,
            commands::state::load_partition,
            commands::state::save_session,
            commands::state::remove_session,
            commands::state::load_sessions,
            commands::search::chat_search_reindex,
            commands::search::chat_search,
            commands::bedrock::bedrock_invoke,
        ])
        .setup(|app| setup::init(app))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
