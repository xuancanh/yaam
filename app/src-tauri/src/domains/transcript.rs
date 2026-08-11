//! Poll-tail a coding CLI's JSONL transcript and forward complete new lines to
//! the frontend as `transcript-lines` events. Claude Code's transcript path is
//! derivable at launch (we mint the session id), so a watcher can start before
//! the file exists: a file that appears later streams from the beginning, while
//! a file that already exists is tailed from its current end (resume — only new
//! events flow). Reading is bounded per tick and pathological lines are skipped,
//! so a runaway transcript can't flood the IPC bridge.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::util::expand_tilde;

const POLL_MS: u64 = 700;
/// max bytes consumed per tick — the rest waits for the next poll
const MAX_BATCH_BYTES: usize = 1_000_000;
/// individual lines beyond this are dropped (giant embedded tool results)
const MAX_LINE_BYTES: usize = 2_000_000;

#[derive(Default)]
pub struct TranscriptManager {
    watchers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, serde::Serialize)]
struct TranscriptLines {
    agent: String,
    lines: Vec<String>,
}

/// Claude Code transcript file for a session: the project dir encodes the cwd
/// with `/` and `.` replaced by `-` (matches detect_cli_session).
fn claude_transcript_path(home: &str, cwd: &str, session_id: &str) -> std::path::PathBuf {
    let base = expand_tilde(if cwd.is_empty() { home } else { cwd });
    let encoded = base.replace(['/', '.'], "-");
    std::path::PathBuf::from(home)
        .join(".claude/projects")
        .join(encoded)
        .join(format!("{session_id}.jsonl"))
}

fn tail_loop(app: AppHandle, agent: String, path: std::path::PathBuf, stop: Arc<AtomicBool>) {
    // existing file = resume: only stream what the session writes from now on
    let mut offset: u64 = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut carry: Vec<u8> = Vec::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let len = meta.len();
        if len < offset {
            // truncated/rewritten — start over from the top
            offset = 0;
            carry.clear();
        }
        if len == offset {
            continue;
        }
        let Ok(mut f) = std::fs::File::open(&path) else { continue };
        if f.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let budget = ((len - offset) as usize).min(MAX_BATCH_BYTES);
        let mut buf = vec![0u8; budget];
        let Ok(n) = f.read(&mut buf) else { continue };
        if n == 0 {
            continue;
        }
        offset += n as u64;
        carry.extend_from_slice(&buf[..n]);
        // a carry with no newline that keeps growing is one pathological line
        if carry.len() > MAX_LINE_BYTES && !carry.contains(&b'\n') {
            carry.clear();
            continue;
        }
        let mut lines: Vec<String> = Vec::new();
        while let Some(pos) = carry.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = carry.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.is_empty() || line.len() > MAX_LINE_BYTES {
                continue;
            }
            lines.push(String::from_utf8_lossy(line).into_owned());
        }
        if !lines.is_empty() {
            let _ = app.emit("transcript-lines", TranscriptLines { agent: agent.clone(), lines });
        }
    }
}

/// Start (or replace) the transcript watcher for one YAAM session.
#[tauri::command]
pub fn transcript_watch(
    app: AppHandle,
    state: State<TranscriptManager>,
    agent: String,
    kind: String,
    cwd: String,
    session_id: String,
) -> Result<(), String> {
    if kind != "claude" {
        return Err(format!("unsupported transcript kind: {kind}"));
    }
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.contains("..") {
        return Err("invalid session id".to_string());
    }
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path = claude_transcript_path(&home, &cwd, &session_id);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut watchers = state
            .watchers
            .lock()
            .map_err(|_| "transcript watcher lock poisoned".to_string())?;
        if let Some(old) = watchers.insert(agent.clone(), stop.clone()) {
            old.store(true, Ordering::Relaxed);
        }
    }
    std::thread::spawn(move || tail_loop(app, agent, path, stop));
    Ok(())
}

/// Stop a session's transcript watcher (archive/delete).
#[tauri::command]
pub fn transcript_unwatch(state: State<TranscriptManager>, agent: String) {
    if let Ok(mut watchers) = state.watchers.lock() {
        if let Some(stop) = watchers.remove(&agent) {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_path_encodes_cwd_like_detection() {
        let p = claude_transcript_path("/Users/u", "/Users/u/my.app", "abc-123");
        assert_eq!(
            p,
            std::path::PathBuf::from("/Users/u/.claude/projects/-Users-u-my-app/abc-123.jsonl")
        );
    }

    #[test]
    fn transcript_path_falls_back_to_home() {
        let p = claude_transcript_path("/Users/u", "", "abc");
        assert_eq!(
            p,
            std::path::PathBuf::from("/Users/u/.claude/projects/-Users-u/abc.jsonl")
        );
    }
}
