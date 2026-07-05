//! Git inspection for the diff-review drawer: working-tree diffs and porcelain
//! status, scoped to a session's working directory.
use crate::util::expand_tilde;
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

fn parse_porcelain_status(root: String, output: &[u8]) -> GitStatusResult {
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(output).lines() {
        if line.len() < 4 || line.as_bytes().get(2) != Some(&b' ') {
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
    GitStatusResult { root, files }
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
    Ok(parse_porcelain_status(root, &out.stdout))
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

#[tauri::command]
pub fn git_diff(cwd: String) -> Result<String, String> {
    diff(&cwd)
}

#[tauri::command]
pub fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    status(&cwd)
}

#[tauri::command]
pub fn git_file_diff(cwd: String, path: String) -> Result<String, String> {
    file_diff(&cwd, &path)
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_status;

    #[test]
    fn parses_modified_staged_and_untracked_statuses() {
        let result = parse_porcelain_status(
            "/repo".to_string(),
            b" M src/main.rs\nA  src/new.rs\n?? notes.txt\ninvalid\n",
        );

        assert_eq!(result.root, "/repo");
        let actual: Vec<_> = result
            .files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("M", "src/main.rs"),
                ("A", "src/new.rs"),
                ("??", "notes.txt"),
            ]
        );
    }

    #[test]
    fn reports_the_destination_of_a_rename() {
        let result =
            parse_porcelain_status("/repo".to_string(), b"R  old-name.rs -> new-name.rs\n");

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].status, "R");
        assert_eq!(result.files[0].path, "new-name.rs");
    }

    #[test]
    fn strips_porcelain_quotes_from_paths() {
        let result = parse_porcelain_status("/repo".to_string(), b"?? \"file with spaces.txt\"\n");

        assert_eq!(result.files[0].path, "file with spaces.txt");
    }
}
