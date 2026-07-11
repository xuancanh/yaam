//! Git inspection for the diff-review drawer: working-tree diffs and porcelain
//! status, scoped to a session's working directory.
use crate::util::expand_tilde;
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct GitFileStatus {
    path: String,
    status: String,
    /// porcelain X column — the staged (index) state, ' ' when unstaged
    index: String,
    /// porcelain Y column — the worktree state, ' ' when fully staged
    work: String,
}

#[derive(Serialize)]
pub struct GitStatusResult {
    root: String,
    branch: String,
    files: Vec<GitFileStatus>,
}

fn parse_porcelain_status(root: String, branch: String, output: &[u8]) -> GitStatusResult {
    let mut files = Vec::new();
    let fields: Vec<&[u8]> = output.split(|b| *b == 0).filter(|field| !field.is_empty()).collect();
    let mut i = 0;
    while i < fields.len() {
        let field = fields[i];
        i += 1;
        if field.len() < 4 || field.get(2) != Some(&b' ') {
            continue;
        }
        let index = field[0] as char;
        let work = field[1] as char;
        // In porcelain -z, rename/copy records carry the destination first and
        // the source as the following NUL field. The UI wants the destination.
        if matches!(index, 'R' | 'C') || matches!(work, 'R' | 'C') {
            i = (i + 1).min(fields.len());
        }
        files.push(GitFileStatus {
            path: String::from_utf8_lossy(&field[3..]).into_owned(),
            status: String::from_utf8_lossy(&field[..2]).trim().to_string(),
            index: index.to_string(),
            work: work.to_string(),
        });
    }
    GitStatusResult {
        root,
        branch,
        files,
    }
}

/// Run one git command in `cwd`, mapping failures to trimmed stderr.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(expand_tilde(cwd))
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(if err.is_empty() { stdout } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let out = Command::new("git")
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_porcelain_status(root, branch, &out.stdout))
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

/// Full-context diff of one file for the staging UI: staged (index vs HEAD)
/// or unstaged (worktree vs index).
#[tauri::command]
pub fn git_file_diff_side(cwd: String, path: String, staged: bool) -> Result<String, String> {
    if staged {
        run_git(&cwd, &["diff", "--no-color", "--cached", "--", &path])
    } else {
        run_git(&cwd, &["diff", "--no-color", "--", &path])
    }
}

#[tauri::command]
pub fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&cwd, &args).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(&cwd, &args).map(|_| ())
}

/// Commit the staged changes; returns git's one-line summary.
#[tauri::command]
pub fn git_commit(cwd: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    run_git(&cwd, &["commit", "-m", &message])
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_status;

    #[test]
    fn parses_modified_staged_and_untracked_statuses() {
        let result = parse_porcelain_status(
            "/repo".to_string(),
            "main".to_string(),
            b" M src/main.rs\0A  src/new.rs\0?? notes.txt\0invalid\0",
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
        let result = parse_porcelain_status(
            "/repo".to_string(),
            "main".to_string(),
            b"R  new-name.rs\0old-name.rs\0",
        );

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].status, "R");
        assert_eq!(result.files[0].path, "new-name.rs");
    }

    #[test]
    fn preserves_spaces_newlines_and_arrow_text_in_paths() {
        let result = parse_porcelain_status(
            "/repo".to_string(),
            "main".to_string(),
            b"?? file with spaces.txt\0?? line\nbreak -> literal.txt\0",
        );

        assert_eq!(result.files[0].path, "file with spaces.txt");
        assert_eq!(result.files[1].path, "line\nbreak -> literal.txt");
    }
}
