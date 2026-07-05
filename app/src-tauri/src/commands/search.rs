//! IPC handlers for the embedded chat search index.
use crate::core::search::{self, ChatDoc, ChatHit, ChatSearchState};
use tauri::State;

#[tauri::command]
pub fn chat_search_reindex(state: State<'_, ChatSearchState>, docs: Vec<ChatDoc>) -> Result<usize, String> {
    search::reindex(&state, docs)
}

#[tauri::command]
pub fn chat_search(state: State<'_, ChatSearchState>, query: String, limit: Option<usize>) -> Result<Vec<ChatHit>, String> {
    search::search(&state, query, limit)
}
