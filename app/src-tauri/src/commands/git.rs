//! IPC handlers for the diff-review drawer.
use crate::core::git::{self, GitStatusResult};

#[tauri::command]
pub fn git_diff(cwd: String) -> Result<String, String> {
    git::diff(&cwd)
}

#[tauri::command]
pub fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    git::status(&cwd)
}

#[tauri::command]
pub fn git_file_diff(cwd: String, path: String) -> Result<String, String> {
    git::file_diff(&cwd, &path)
}
