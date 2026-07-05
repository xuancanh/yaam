//! IPC handlers for PTY sessions and CLI session detection.
use crate::core::detect;
use crate::core::pty::SessionManager;
use tauri::{AppHandle, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    command: String,
    terminal_shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    state.spawn(app, id, command, terminal_shell, cwd, rows, cols)
}

#[tauri::command]
pub fn write_session(state: State<'_, SessionManager>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
pub fn resize_session(state: State<'_, SessionManager>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    state.resize(&id, rows, cols)
}

#[tauri::command]
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    state.kill(&id);
    Ok(())
}

#[tauri::command]
pub fn live_sessions(state: State<'_, SessionManager>) -> Vec<String> {
    state.live_ids()
}

#[tauri::command]
pub fn detect_cli_session(kind: String, cwd: Option<String>, since_ms: f64, exclude: Vec<String>) -> Option<String> {
    detect::detect(&kind, cwd, since_ms, &exclude)
}
