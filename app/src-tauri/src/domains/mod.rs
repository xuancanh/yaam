//! Backend domains. Each module keeps its managed state, business logic,
//! Tauri command boundary, and unit tests together.
pub mod bedrock;
pub mod fs;
pub mod git;
pub mod mcp;
pub mod remote;
pub mod search;
pub mod secrets;
pub mod session;
pub mod state;
pub mod watch;
pub mod worktree;
