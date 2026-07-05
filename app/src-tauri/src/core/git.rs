//! Git inspection for the diff-review drawer: working-tree diffs and porcelain
//! status, scoped to a session's working directory.
use crate::core::util::expand_tilde;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitFileStatus {
    path: String,
    status: String,
}

#[derive(Serialize)]
pub struct GitStatusResult {
    root: String,
    files: Vec<GitFileStatus>,
}

/// Complete working-tree diff against HEAD for a session directory.
pub fn diff(cwd: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--no-color", "HEAD"])
        .current_dir(expand_tilde(cwd))
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Repo root + porcelain status (paths relative to the root).
pub fn status(cwd: &str) -> Result<GitStatusResult, String> {
    let dir = expand_tilde(cwd);
    let root_out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !root_out.status.success() {
        return Err("not a git repository".to_string());
    }
    let root = String::from_utf8_lossy(&root_out.stdout).trim().to_string();
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let mut path = line[3..].to_string();
        if let Some((_, to)) = path.split_once(" -> ") {
            path = to.to_string();
        }
        files.push(GitFileStatus {
            path: path.trim_matches('"').to_string(),
            status,
        });
    }
    Ok(GitStatusResult { root, files })
}

/// Zero-context diff of one file vs HEAD — the frontend parses hunk headers
/// into added/modified line markers for the gutter.
pub fn file_diff(cwd: &str, path: &str) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--no-color", "-U0", "HEAD", "--", path])
        .current_dir(expand_tilde(cwd))
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}
