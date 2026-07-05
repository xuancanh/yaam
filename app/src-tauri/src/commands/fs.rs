//! IPC handlers for filesystem access and one-shot process execution.
use crate::core::fs::{self, DirEntryInfo, ExecResult};

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    fs::list_dir(&path)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_text(&path)
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write_text(&path, &contents)
}

#[tauri::command]
pub async fn run_credential_command(cmd: String) -> Result<String, String> {
    fs::run_credential_command(cmd).await
}

#[tauri::command]
pub async fn exec_command(cmd: String, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<ExecResult, String> {
    fs::exec_command(cmd, cwd, timeout_ms).await
}
