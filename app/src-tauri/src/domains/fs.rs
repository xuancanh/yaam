//! Filesystem and one-shot process execution used by chat agents and the file
//! pane: directory listing, text read/write, credential commands, and a
//! timeout-bounded shell exec.
use crate::util::expand_tilde;
use serde::Serialize;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_DIR_ENTRIES: usize = 10_000;
const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;

/// Authorize a workspace-scoped path at the privileged boundary. Lexical checks
/// in the frontend are advisory only: a symlink under the workspace can point
/// outside it while the lexical path still looks local. Here we canonicalize the
/// real filesystem (resolving symlinks) and reject any target whose canonical
/// location — or, for a not-yet-created file, its nearest existing ancestor —
/// falls outside the canonical workspace root.
///
/// `root` must exist. `path` is taken relative to `root` unless absolute. The
/// returned path is safe to open immediately (the check runs against the live
/// filesystem right before use, shrinking the TOCTOU window).
fn resolve_in_root(root: &str, path: &str) -> Result<PathBuf, String> {
    let canon_root = std::fs::canonicalize(expand_tilde(root))
        .map_err(|e| format!("workspace root unavailable: {e}"))?;
    let raw = expand_tilde(path);
    let target = if Path::new(&raw).is_absolute() {
        PathBuf::from(&raw)
    } else {
        canon_root.join(&raw)
    };

    // Split into the longest existing ancestor (canonicalized, so symlinks are
    // resolved to their real location) and the non-existing tail.
    let mut ancestor = target.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let canon_ancestor = loop {
        if let Ok(c) = std::fs::canonicalize(&ancestor) {
            break c;
        }
        let file = ancestor
            .file_name()
            .ok_or_else(|| "invalid path".to_string())?
            .to_os_string();
        tail.push(file);
        if !ancestor.pop() {
            return Err("path has no existing ancestor".to_string());
        }
    };

    // The non-existing tail cannot contain symlinks (it doesn't exist yet), but
    // reject any `.`/`..` so it can't climb back out of the resolved base.
    let mut resolved = canon_ancestor;
    for comp in tail.iter().rev() {
        if comp == ".." || comp == "." {
            return Err("path may not contain '..'".to_string());
        }
        resolved.push(comp);
    }

    if !resolved.starts_with(&canon_root) {
        return Err(format!(
            "refusing to access a path outside the workspace root ({})",
            canon_root.display()
        ));
    }
    Ok(resolved)
}

/// Resolve `path` against an optional workspace `root`. With a root, the path is
/// authorized + canonicalized (symlink-safe); without one, it is a trusted,
/// user-driven access (file pane, skills) and only tilde-expanded.
fn scoped_path(root: Option<&str>, path: &str) -> Result<PathBuf, String> {
    match root {
        Some(r) => resolve_in_root(r, path),
        None => Ok(PathBuf::from(expand_tilde(path))),
    }
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct ExecResult {
    pub code: i32,
    pub output: String,
}

/// List a directory with folders first and case-insensitive name ordering.
fn list_dir_impl(root: Option<&str>, path: &str) -> Result<Vec<DirEntryInfo>, String> {
    list_dir_with_limit(root, path, MAX_DIR_ENTRIES)
}

fn list_dir_with_limit(root: Option<&str>, path: &str, max_entries: usize) -> Result<Vec<DirEntryInfo>, String> {
    let dir = scoped_path(root, path)?;
    let mut out: Vec<DirEntryInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if out.len() >= max_entries {
            return Err(format!("directory contains more than {max_entries} entries"));
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Read one UTF-8 text file, authorized against an optional workspace root.
fn read_text_impl(root: Option<&str>, path: &str) -> Result<String, String> {
    let full = scoped_path(root, path)?;
    let size = std::fs::metadata(&full).map_err(|e| e.to_string())?.len();
    if size > MAX_TEXT_BYTES {
        return Err(format!("text file is {size} bytes — over the {MAX_TEXT_BYTES} byte limit"));
    }
    std::fs::read_to_string(full).map_err(|e| e.to_string())
}

/// A ranged text read: the requested 1-based line window plus the file's total
/// line count, so the viewer/agent can page a large file without marshalling it
/// whole across IPC. `offset` is 1-based; `limit` caps the returned lines.
#[derive(Serialize)]
pub struct TextRange {
    lines: Vec<String>,
    total: usize,
    /// 1-based line number of the first returned line
    start: usize,
}

fn read_text_range_impl(
    root: Option<&str>,
    path: &str,
    offset: usize,
    limit: usize,
) -> Result<TextRange, String> {
    let start = offset.max(1);
    let take = limit.max(1);
    let file = std::fs::File::open(scoped_path(root, path)?).map_err(|e| e.to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut lines = Vec::with_capacity(take.min(10_000));
    let mut total = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 {
            // str::split('\n') reports one empty line for an empty file and
            // one final empty line when the file ends in a newline.
            if total == 0 {
                total += 1;
                if total >= start && lines.len() < take {
                    lines.push(String::new());
                }
            }
            break;
        }
        total += 1;
        let had_newline = line.ends_with('\n');
        if had_newline {
            line.pop();
            if line.ends_with('\r') { line.pop(); }
        }
        if total >= start && lines.len() < take {
            lines.push(line.clone());
        }
        if !had_newline { break; }
        // A trailing newline produces a final empty split segment. Peek one
        // byte without retaining the rest of the file.
        if reader.fill_buf().map_err(|e| e.to_string())?.is_empty() {
            total += 1;
            if total >= start && lines.len() < take { lines.push(String::new()); }
            break;
        }
    }
    Ok(TextRange {
        lines,
        total,
        start,
    })
}

/// Drain a pipe completely while retaining only its bounded tail. Continuing
/// to drain is essential: stopping at the cap would block the child on a full
/// OS pipe and turn truncation into a deadlock.
fn read_capped_tail<R: Read>(reader: &mut R, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(cap);
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        kept.extend_from_slice(&chunk[..n]);
        if kept.len() > cap {
            let excess = kept.len() - cap;
            kept.drain(..excess);
            truncated = true;
        }
    }
    (kept, truncated)
}

/// Read one file as base64 — the viewer/import path for binary formats (PDF,
/// office docs, images). Size-capped so a stray multi-GB file cannot be
/// marshalled through the IPC bridge.
fn read_file_b64_impl(root: Option<&str>, path: &str, max_bytes: u64) -> Result<String, String> {
    use base64::Engine;
    let full = scoped_path(root, path)?;
    let meta = std::fs::metadata(&full).map_err(|e| e.to_string())?;
    if meta.len() > max_bytes {
        return Err(format!(
            "file is {} bytes — over the {} byte limit",
            meta.len(),
            max_bytes
        ));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Create or replace one file with UTF-8 text, creating parent directories,
/// authorized against an optional workspace root.
fn write_text_impl(root: Option<&str>, path: &str, contents: &str) -> Result<(), String> {
    if contents.len() as u64 > MAX_TEXT_BYTES {
        return Err(format!("text is {} bytes — over the {MAX_TEXT_BYTES} byte limit", contents.len()));
    }
    let full = scoped_path(root, path)?;
    if let Some(parent) = full.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&full, contents).map_err(|e| e.to_string())
}

fn create_dir_impl(root: &str, path: &str) -> Result<(), String> {
    let full = resolve_in_root(root, path)?;
    std::fs::create_dir_all(full).map_err(|e| e.to_string())
}

fn move_path_impl(root: &str, from: &str, to: &str) -> Result<(), String> {
    let source = resolve_in_root(root, from)?;
    let target = resolve_in_root(root, to)?;
    if source == std::fs::canonicalize(expand_tilde(root)).map_err(|e| e.to_string())? {
        return Err("refusing to move the workspace root".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(source, target).map_err(|e| e.to_string())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing to copy symlink {}", source.display()));
    }
    if meta.is_dir() {
        std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(source, target)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn copy_path_impl(root: &str, from: &str, to: &str) -> Result<(), String> {
    let source = PathBuf::from(expand_tilde(from));
    let target = resolve_in_root(root, to)?;
    copy_tree(&source, &target)
}

fn delete_path_impl(root: &str, path: &str) -> Result<(), String> {
    let full = resolve_in_root(root, path)?;
    let canon_root = std::fs::canonicalize(expand_tilde(root)).map_err(|e| e.to_string())?;
    if full == canon_root {
        return Err("refusing to delete the workspace root".to_string());
    }
    let meta = std::fs::symlink_metadata(&full).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(full).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(full).map_err(|e| e.to_string())
    }
}

/// Run a user-configured credential command through a login shell and return
/// its stdout (e.g. `claude default-credential-export`, corporate token CLIs).
pub(crate) async fn run_credential_command_impl(cmd: String) -> Result<String, String> {
    run_credential_command_with_limits(cmd, std::time::Duration::from_secs(30), 1024 * 1024).await
}

async fn run_credential_command_with_limits(
    cmd: String,
    timeout: std::time::Duration,
    cap: usize,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("/bin/sh");
        command.args(["-lc", &cmd])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()
            .map_err(|e| format!("credential command failed to run: {e}"))?;
        let pid = child.id() as i32;
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let out_thread = std::thread::spawn(move || stdout.as_mut()
            .map(|p| read_capped_tail(p, cap)).unwrap_or_default());
        let err_thread = std::thread::spawn(move || stderr.as_mut()
            .map(|p| read_capped_tail(p, cap)).unwrap_or_default());
        let started = std::time::Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
            if started.elapsed() >= timeout {
                #[cfg(unix)]
                unsafe { libc::kill(-pid, libc::SIGKILL); }
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(format!("credential command timed out after {}s", timeout.as_secs_f32()));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        let (stdout, stdout_truncated) = out_thread.join().unwrap_or_default();
        let (stderr, stderr_truncated) = err_thread.join().unwrap_or_default();
        if stdout_truncated || stderr_truncated {
            return Err(format!("credential command output exceeds {cap} bytes"));
        }
        if !status.success() {
            return Err(format!(
                "credential command exited with {}: {}",
                status.code().unwrap_or(-1),
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One-shot shell execution for chat agents: run a command, capture merged
/// output (capped), enforce a wall-clock timeout by killing the child's group.
async fn exec_command_impl(
    cmd: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(60_000).min(300_000));
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = Command::new("/bin/sh");
        c.args(["-lc", &cmd])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            // own process group: a timeout kill reaches grandchildren too
            use std::os::unix::process::CommandExt;
            c.process_group(0);
        }
        if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
            c.current_dir(expand_tilde(&dir));
        }
        let mut child = c.spawn().map_err(|e| format!("failed to run: {e}"))?;
        let pid = child.id() as i32;
        // drain both pipes on their own threads — a child that writes more
        // than the pipe buffer would otherwise block forever before exiting
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        const PIPE_CAP: usize = 40_000;
        let out_thread = std::thread::spawn(move || stdout_pipe.as_mut()
            .map(|p| read_capped_tail(p, PIPE_CAP)).unwrap_or_default());
        let err_thread = std::thread::spawn(move || stderr_pipe.as_mut()
            .map(|p| read_capped_tail(p, PIPE_CAP)).unwrap_or_default());
        let kill_tree = |child: &mut std::process::Child| {
            #[cfg(unix)]
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        };
        let start = std::time::Instant::now();
        let (status, timed_out) = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break (Some(status), false),
                None => {
                    if start.elapsed() > timeout {
                        kill_tree(&mut child);
                        break (None, true);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        };
        let (stdout_buf, stdout_truncated) = out_thread.join().unwrap_or_default();
        let (stderr_buf, stderr_truncated) = err_thread.join().unwrap_or_default();
        let mut text = String::from_utf8_lossy(&stdout_buf).to_string();
        let err = String::from_utf8_lossy(&stderr_buf);
        if !err.trim().is_empty() {
            if !text.trim().is_empty() {
                text.push('\n');
            }
            text.push_str(&err);
        }
        if stdout_truncated || stderr_truncated {
            text = format!("… (output truncated)\n{text}");
        }
        if timed_out {
            if !text.trim().is_empty() {
                text.push('\n');
            }
            text.push_str(&format!(
                "command timed out after {}s and was killed",
                timeout.as_secs()
            ));
        }
        // cap what travels back to the LLM
        const CAP: usize = PIPE_CAP;
        if text.len() > CAP {
            let tail_at = text.len() - CAP;
            let cut = text
                .char_indices()
                .map(|(i, _)| i)
                .find(|&i| i >= tail_at)
                .unwrap_or(0);
            text = format!("… (output truncated)\n{}", &text[cut..]);
        }
        Ok(ExecResult {
            code: status.map(|st| st.code().unwrap_or(-1)).unwrap_or(-1),
            output: text,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn list_dir(path: String, root: Option<String>) -> Result<Vec<DirEntryInfo>, String> {
    list_dir_impl(root.as_deref(), &path)
}

#[tauri::command]
pub fn read_text_file(path: String, root: Option<String>) -> Result<String, String> {
    read_text_impl(root.as_deref(), &path)
}

#[tauri::command]
pub fn read_text_range(
    path: String,
    offset: usize,
    limit: usize,
    root: Option<String>,
) -> Result<TextRange, String> {
    read_text_range_impl(root.as_deref(), &path, offset, limit)
}

#[tauri::command]
pub fn read_file_b64(
    path: String,
    root: Option<String>,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    read_file_b64_impl(
        root.as_deref(),
        &path,
        max_bytes.unwrap_or(25 * 1024 * 1024),
    )
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String, root: Option<String>) -> Result<(), String> {
    write_text_impl(root.as_deref(), &path, &contents)
}

#[tauri::command]
pub fn create_dir(root: String, path: String) -> Result<(), String> {
    create_dir_impl(&root, &path)
}

#[tauri::command]
pub fn move_path(root: String, from: String, to: String) -> Result<(), String> {
    move_path_impl(&root, &from, &to)
}

#[tauri::command]
pub fn copy_path(root: String, from: String, to: String) -> Result<(), String> {
    copy_path_impl(&root, &from, &to)
}

#[tauri::command]
pub fn delete_path(root: String, path: String) -> Result<(), String> {
    delete_path_impl(&root, &path)
}

#[tauri::command]
pub async fn run_credential_command(cmd: String) -> Result<String, String> {
    run_credential_command_impl(cmd).await
}

#[tauri::command]
pub async fn exec_command(
    cmd: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    exec_command_impl(cmd, cwd, timeout_ms).await
}

#[cfg(test)]
mod tests {
    use super::{
        copy_path_impl, create_dir_impl, delete_path_impl, exec_command_impl, list_dir_impl,
        list_dir_with_limit,
        move_path_impl, read_text_impl, read_text_range_impl, resolve_in_root,
        run_credential_command_impl, run_credential_command_with_limits, write_text_impl,
    };
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("yaam-fs-{label}-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_text_creates_parents_and_round_trips_utf8() {
        let dir = TestDir::new("round-trip");
        let file = dir.path().join("nested/path/note.txt");
        let path = file.to_string_lossy();

        write_text_impl(None, &path, "hello 世界").unwrap();

        assert_eq!(read_text_impl(None, &path).unwrap(), "hello 世界");
    }

    #[test]
    fn list_dir_sorts_directories_first_then_names_case_insensitively() {
        let dir = TestDir::new("listing");
        std::fs::write(dir.path().join("beta.txt"), "").unwrap();
        std::fs::write(dir.path().join("Alpha.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("z-dir")).unwrap();
        std::fs::create_dir(dir.path().join("A-dir")).unwrap();

        let entries = list_dir_impl(None, &dir.path().to_string_lossy()).unwrap();
        let actual: Vec<_> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_dir))
            .collect();

        assert_eq!(
            actual,
            vec![
                ("A-dir", true),
                ("z-dir", true),
                ("Alpha.txt", false),
                ("beta.txt", false),
            ]
        );
        assert!(entries
            .iter()
            .all(|entry| Path::new(&entry.path).is_absolute()));
    }

    #[test]
    fn list_dir_rejects_results_over_the_entry_budget() {
        let dir = TestDir::new("listing-cap");
        for name in ["a", "b", "c"] {
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        let error = match list_dir_with_limit(None, &dir.path().to_string_lossy(), 2) {
            Err(error) => error,
            Ok(_) => panic!("oversized listing should be rejected"),
        };
        assert!(error.contains("more than 2 entries"));
    }

    #[test]
    fn text_reads_and_writes_reject_oversized_content() {
        let dir = TestDir::new("text-cap");
        let path = dir.path().join("large.txt");
        let oversized = vec![b'x'; super::MAX_TEXT_BYTES as usize + 1];
        let text = std::str::from_utf8(&oversized).unwrap();
        assert!(write_text_impl(None, &path.to_string_lossy(), text).unwrap_err().contains("over the"));

        std::fs::write(&path, &oversized).unwrap();
        assert!(read_text_impl(None, &path.to_string_lossy()).unwrap_err().contains("over the"));
    }

    #[test]
    fn credential_command_trims_stdout_and_reports_stderr() {
        let value = tauri::async_runtime::block_on(run_credential_command_impl(
            "printf '  token-value  \\n'".to_string(),
        ))
        .unwrap();
        assert_eq!(value, "token-value");

        let error = tauri::async_runtime::block_on(run_credential_command_impl(
            "printf 'credential denied' >&2; exit 7".to_string(),
        ))
        .unwrap_err();
        assert!(error.contains("exited with 7"));
        assert!(error.contains("credential denied"));

        let timeout = tauri::async_runtime::block_on(run_credential_command_with_limits(
            "sleep 2".to_string(),
            std::time::Duration::from_millis(20),
            1024,
        ))
        .unwrap_err();
        assert!(timeout.contains("timed out"));

        let oversized = tauri::async_runtime::block_on(run_credential_command_with_limits(
            "yes x | head -n 10000".to_string(),
            std::time::Duration::from_secs(2),
            1024,
        ))
        .unwrap_err();
        assert!(oversized.contains("exceeds"));
    }

    #[test]
    fn exec_command_merges_output_and_preserves_the_exit_code() {
        let result = tauri::async_runtime::block_on(exec_command_impl(
            "printf stdout; printf stderr >&2; exit 7".to_string(),
            None,
            Some(2_000),
        ))
        .unwrap();

        assert_eq!(result.code, 7);
        assert!(result.output.contains("stdout"));
        assert!(result.output.contains("stderr"));
    }

    #[test]
    fn exec_command_enforces_its_timeout() {
        let result = tauri::async_runtime::block_on(exec_command_impl(
            "sleep 2".to_string(),
            None,
            Some(20),
        ))
        .unwrap();

        assert_eq!(result.code, -1);
        assert!(result.output.contains("timed out"));
    }

    #[test]
    fn exec_command_bounds_noisy_output_while_preserving_the_tail() {
        let result = tauri::async_runtime::block_on(exec_command_impl(
            "yes x | head -n 100000; printf 'FINAL-MARKER\\n'".to_string(),
            None,
            Some(5_000),
        ))
        .unwrap();

        assert_eq!(result.code, 0);
        assert!(result.output.starts_with("… (output truncated)"));
        assert!(result.output.contains("FINAL-MARKER"));
        assert!(result.output.len() < 41_000);
    }

    // ---- workspace scope authorization (resolve_in_root) ----

    // canonicalize the temp dir up front: on macOS it lives under /var -> /private/var
    fn canon(p: &Path) -> PathBuf {
        std::fs::canonicalize(p).unwrap()
    }

    #[test]
    fn scope_allows_a_relative_path_inside_the_root() {
        let dir = TestDir::new("scope-ok");
        let resolved = resolve_in_root(&dir.path().to_string_lossy(), "sub/file.txt").unwrap();
        assert!(resolved.starts_with(canon(dir.path())));
        assert!(resolved.ends_with("sub/file.txt"));
    }

    #[test]
    fn scope_allows_a_nonexistent_target_whose_parent_is_inside_the_root() {
        let dir = TestDir::new("scope-new");
        // write should be allowed to create a brand-new nested file
        write_text_impl(
            Some(&dir.path().to_string_lossy()),
            "deep/new/note.txt",
            "hi",
        )
        .unwrap();
        assert_eq!(
            read_text_impl(Some(&dir.path().to_string_lossy()), "deep/new/note.txt").unwrap(),
            "hi"
        );
    }

    #[test]
    fn scope_rejects_a_parent_traversal_escape() {
        let dir = TestDir::new("scope-dotdot");
        let err = resolve_in_root(&dir.path().to_string_lossy(), "../../etc/passwd").unwrap_err();
        assert!(err.contains("outside the workspace root"));
    }

    #[test]
    fn scope_rejects_an_absolute_path_outside_the_root() {
        let dir = TestDir::new("scope-abs");
        let err = resolve_in_root(&dir.path().to_string_lossy(), "/etc/hosts").unwrap_err();
        assert!(err.contains("outside the workspace root"));
    }

    #[cfg(unix)]
    #[test]
    fn scope_rejects_a_symlinked_file_pointing_outside_the_root() {
        let outside = TestDir::new("scope-outside");
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        let root = TestDir::new("scope-symfile");
        // a symlink INSIDE the workspace that points at a file OUTSIDE it
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("link.txt"),
        )
        .unwrap();

        // lexically "link.txt" looks workspace-local, but it resolves outside
        let err = read_text_impl(Some(&root.path().to_string_lossy()), "link.txt").unwrap_err();
        assert!(err.contains("outside the workspace root"));
    }

    #[cfg(unix)]
    #[test]
    fn scope_rejects_a_write_through_a_symlinked_directory() {
        let outside = TestDir::new("scope-outdir");
        let root = TestDir::new("scope-symdir");
        // a symlinked directory inside the workspace pointing outside it
        std::os::unix::fs::symlink(outside.path(), root.path().join("out")).unwrap();

        // writing "out/pwned.txt" would land outside the workspace via the symlink
        let err = write_text_impl(Some(&root.path().to_string_lossy()), "out/pwned.txt", "x")
            .unwrap_err();
        assert!(err.contains("outside the workspace root"));
        assert!(!outside.path().join("pwned.txt").exists());
    }

    #[test]
    fn scope_rejects_a_missing_root() {
        let err = resolve_in_root("/no/such/workspace/root/here", "file.txt").unwrap_err();
        assert!(err.contains("workspace root unavailable"));
    }

    #[test]
    fn scoped_file_management_stays_inside_the_root() {
        let root = TestDir::new("scoped-management");
        let root_s = root.path().to_string_lossy();
        create_dir_impl(&root_s, "incoming/nested").unwrap();
        std::fs::write(root.path().join("incoming/nested/source.txt"), "hello").unwrap();

        move_path_impl(&root_s, "incoming/nested/source.txt", "moved/source.txt").unwrap();
        copy_path_impl(
            &root_s,
            &root.path().join("moved/source.txt").to_string_lossy(),
            "copies/source.txt",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("copies/source.txt")).unwrap(),
            "hello"
        );
        delete_path_impl(&root_s, "moved").unwrap();
        assert!(!root.path().join("moved").exists());
    }

    #[test]
    fn scoped_file_management_refuses_the_root() {
        let root = TestDir::new("scoped-root-refusal");
        let root_s = root.path().to_string_lossy();
        assert!(delete_path_impl(&root_s, &root_s)
            .unwrap_err()
            .contains("workspace root"));
        assert!(move_path_impl(&root_s, &root_s, "elsewhere")
            .unwrap_err()
            .contains("workspace root"));
    }

    #[cfg(unix)]
    #[test]
    fn scoped_file_management_rejects_symlink_escapes() {
        let outside = TestDir::new("management-outside");
        let root = TestDir::new("management-symlink");
        std::os::unix::fs::symlink(outside.path(), root.path().join("outside")).unwrap();
        let root_s = root.path().to_string_lossy();

        assert!(create_dir_impl(&root_s, "outside/new-dir")
            .unwrap_err()
            .contains("outside"));
        assert!(delete_path_impl(&root_s, "outside")
            .unwrap_err()
            .contains("outside"));
        assert!(!outside.path().join("new-dir").exists());
    }

    #[test]
    fn read_text_range_returns_the_requested_window_and_total() {
        let dir = TestDir::new("ranged");
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "l1\nl2\nl3\nl4\nl5").unwrap();
        let p = file.to_string_lossy();

        let r = read_text_range_impl(None, &p, 2, 2).unwrap();
        assert_eq!(r.lines, vec!["l2".to_string(), "l3".to_string()]);
        assert_eq!(r.total, 5);
        assert_eq!(r.start, 2);

        // a window past the end clamps to what exists
        let tail = read_text_range_impl(None, &p, 5, 10).unwrap();
        assert_eq!(tail.lines, vec!["l5".to_string()]);
        // offset 0 is treated as line 1
        assert_eq!(read_text_range_impl(None, &p, 0, 1).unwrap().start, 1);

        std::fs::write(&file, "l1\nl2\n").unwrap();
        let trailing = read_text_range_impl(None, &p, 1, 10).unwrap();
        assert_eq!(trailing.lines, vec!["l1", "l2", ""]);
        assert_eq!(trailing.total, 3);

        std::fs::write(&file, "").unwrap();
        let empty = read_text_range_impl(None, &p, 1, 10).unwrap();
        assert_eq!(empty.lines, vec![""]);
        assert_eq!(empty.total, 1);
    }
}
