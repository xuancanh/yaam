//! Core layer: domain logic and managed state, independent of the Tauri IPC
//! boundary. The thin `#[tauri::command]` handlers in `commands/` delegate here.
pub mod bedrock;
pub mod detect;
pub mod fs;
pub mod git;
pub mod persistence;
pub mod pty;
pub mod search;
pub mod util;
