//! Command layer: thin `#[tauri::command]` handlers, grouped by domain, that
//! validate input and delegate to the `core` layer. This is the app's IPC
//! boundary — the frontend's `native.ts` wrappers invoke these.
pub mod bedrock;
pub mod fs;
pub mod git;
pub mod search;
pub mod session;
pub mod state;
