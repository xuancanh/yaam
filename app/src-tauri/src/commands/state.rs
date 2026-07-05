//! IPC handlers for durable state storage (main partition, named partitions,
//! and per-session files).
use crate::core::persistence as p;
use tauri::AppHandle;

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    p::save_main(&app, &json)
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    p::load_main(&app)
}

#[tauri::command]
pub fn load_state_backup(app: AppHandle) -> Result<Option<String>, String> {
    p::load_main_backup(&app)
}

#[tauri::command]
pub fn save_partition(app: AppHandle, name: String, json: String) -> Result<(), String> {
    p::save_partition(&app, &name, &json)
}

#[tauri::command]
pub fn load_partition(app: AppHandle, name: String) -> Result<Option<String>, String> {
    p::load_partition(&app, &name)
}

#[tauri::command]
pub fn save_session(app: AppHandle, id: String, json: String) -> Result<(), String> {
    p::save_session(&app, &id, &json)
}

#[tauri::command]
pub fn remove_session(app: AppHandle, id: String) -> Result<(), String> {
    p::remove_session(&app, &id)
}

#[tauri::command]
pub fn load_sessions(app: AppHandle) -> Result<Vec<String>, String> {
    p::load_sessions(&app)
}
