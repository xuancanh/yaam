mod bedrock;
mod chatsearch;
mod sessions;

use bedrock::BedrockState;
use chatsearch::ChatSearchState;
use sessions::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Configure plugins, shared state, commands, and platform setup before running Tauri.
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_http::init())
    .manage(SessionManager::default())
    .manage(BedrockState::default())
    .manage(ChatSearchState::default())
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
      sessions::exec_command,
      chatsearch::chat_search_reindex,
      chatsearch::chat_search,
      sessions::read_text_file,
      sessions::write_text_file,
      sessions::save_state,
      sessions::load_state,
      sessions::load_state_backup,
    ])
    .setup(|app| {
      // `tauri dev` runs a bare binary (no .app bundle), so macOS falls back to
      // a generic dock icon that doesn't match the bundled app — set it here.
      #[cfg(target_os = "macos")]
      {
        use objc2::{AnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        if let Some(mtm) = MainThreadMarker::new() {
          let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
          if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
            unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&img)) };
          }
        }
      }
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
