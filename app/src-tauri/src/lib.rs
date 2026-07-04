mod bedrock;
mod sessions;

use bedrock::BedrockState;
use sessions::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_http::init())
    .manage(SessionManager::default())
    .manage(BedrockState::default())
    .invoke_handler(tauri::generate_handler![
      bedrock::bedrock_invoke,
      sessions::spawn_session,
      sessions::write_session,
      sessions::kill_session,
      sessions::resize_session,
      sessions::live_sessions,
      sessions::detect_cli_session,
      sessions::git_diff,
      sessions::git_status,
      sessions::git_file_diff,
      sessions::list_dir,
      sessions::run_credential_command,
      sessions::read_text_file,
      sessions::write_text_file,
      sessions::save_state,
      sessions::load_state,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
