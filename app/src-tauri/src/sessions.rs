use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Expand a leading home-directory shorthand before filesystem or process use.
fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

/// Resolve a shell name with the user's login PATH without interpolating it
/// into shell code.
fn resolve_login_executable(executable: &str) -> Result<String, String> {
    let requested = expand_tilde(executable.trim());
    if requested.is_empty() {
        return Err("terminal shell is empty".to_string());
    }
    if requested.contains('/') {
        return std::path::Path::new(&requested)
            .is_file()
            .then_some(requested.clone())
            .ok_or_else(|| format!("terminal shell does not exist: {requested}"));
    }
    let out = Command::new("/bin/sh")
        .args(["-lc", "command -v \"$1\""])
        .arg("yaam-shell-resolver")
        .arg(&requested)
        .output()
        .map_err(|e| format!("failed to resolve terminal shell `{requested}`: {e}"))?;
    let resolved = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or_default()
        .to_string();
    if !out.status.success()
        || resolved.is_empty()
        || !std::path::Path::new(&resolved).is_file()
    {
        return Err(format!("terminal shell not found in login PATH: {requested}"));
    }
    Ok(resolved)
}

/// Select the executable, arguments, and SHELL value for command or terminal mode.
fn session_launch_spec(
    command: &str,
    terminal_shell: Option<&str>,
) -> Result<(String, Vec<String>, Option<String>), String> {
    if let Some(shell) = terminal_shell.filter(|shell| !shell.trim().is_empty()) {
        let executable = resolve_login_executable(shell)?;
        return Ok((
            executable.clone(),
            vec!["-l".to_string(), "-i".to_string()],
            Some(executable),
        ));
    }
    Ok((
        "/bin/sh".to_string(),
        vec!["-lc".to_string(), command.to_string()],
        None,
    ))
}

struct SessionHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

#[derive(Clone, Serialize)]
struct DataEvent {
    id: String,
    /// base64-encoded raw PTY bytes
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

#[tauri::command]
/// Spawn a command or direct terminal shell and stream PTY events to React.
pub fn spawn_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    command: String,
    terminal_shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Plain terminals run the selected shell directly. Arbitrary commands still
    // need a login-shell parser for quoting, operators, and the user's GUI PATH.
    let (executable, args, shell_env) =
        session_launch_spec(&command, terminal_shell.as_deref())?;
    let launch_label = if shell_env.is_some() {
        format!("{executable} -l -i")
    } else {
        command.clone()
    };
    let mut cmd = CommandBuilder::new(executable);
    cmd.args(args);
    cmd.env("TERM", "xterm-256color");
    if let Some(shell) = shell_env {
        cmd.env("SHELL", shell);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        let dir = expand_tilde(&dir);
        if !std::path::Path::new(&dir).is_dir() {
            return Err(format!("working directory does not exist: {dir}"));
        }
        cmd.cwd(dir);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn `{launch_label}`: {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    state.sessions.lock().unwrap().insert(
        id.clone(),
        SessionHandle {
            master: pair.master,
            writer,
            killer,
        },
    );

    // stream raw PTY output to the frontend
    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_out.emit("session-data", DataEvent { id: id_out.clone(), data });
                }
            }
        }
    });

    // reap the child and notify the frontend when it exits
    let app_exit = app;
    let id_exit = id;
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let mgr = app_exit.state::<SessionManager>();
        mgr.sessions.lock().unwrap().remove(&id_exit);
        let _ = app_exit.emit("session-exit", ExitEvent { id: id_exit, code });
    });

    Ok(())
}

#[tauri::command]
/// Write text to a session's PTY writer and flush it immediately.
pub fn write_session(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let handle = sessions.get_mut(&id).ok_or("no such session")?;
    handle
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| handle.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
/// Resize a session's PTY so terminal applications receive SIGWINCH.
pub fn resize_session(
    state: State<'_, SessionManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let handle = sessions.get(&id).ok_or("no such session")?;
    handle
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
/// Remove a managed session and ask its child process to terminate.
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut handle) = sessions.remove(&id) {
        let _ = handle.killer.kill();
    }
    Ok(())
}

/// Find the newest JSONL file born after a launch timestamp, optionally recursively.
fn newest_file_since(dir: &std::path::Path, since_ms: u64, recurse: bool) -> Option<(u64, std::path::PathBuf)> {
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recurse {
                if let Some(cand) = newest_file_since(&path, since_ms, true) {
                    if best.as_ref().map(|b| cand.0 > b.0).unwrap_or(true) {
                        best = Some(cand);
                    }
                }
            }
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        // creation time, so a concurrent conversation that keeps appending to an
        // older file can't shadow the session our child process just created
        let meta = entry.metadata().ok()?;
        let created = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)?;
        if created < since_ms {
            continue;
        }
        if best.as_ref().map(|b| created > b.0).unwrap_or(true) {
            best = Some((created, path));
        }
    }
    best
}

/// Detect the session id a CLI created after `since_ms`, so it can be resumed
/// later (claude --resume <id>, codex resume <id>).
#[tauri::command]
pub fn detect_cli_session(kind: String, cwd: Option<String>, since_ms: f64) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let since = since_ms as u64;
    match kind.as_str() {
        "claude" => {
            // sessions live in ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl
            let dir = expand_tilde(&cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| home.clone()));
            let encoded = dir.replace(['/', '.'], "-");
            let project = std::path::PathBuf::from(&home).join(".claude/projects").join(encoded);
            let (_, path) = newest_file_since(&project, since, false)?;
            path.file_stem().map(|s| s.to_string_lossy().to_string())
        }
        "codex" => {
            // ~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl
            let dir = std::path::PathBuf::from(&home).join(".codex/sessions");
            let (_, path) = newest_file_since(&dir, since, true)?;
            let stem = path.file_stem()?.to_string_lossy().to_string();
            if stem.len() >= 36 {
                Some(stem[stem.len() - 36..].to_string())
            } else {
                Some(stem)
            }
        }
        _ => None,
    }
}

#[tauri::command]
/// Return the ids of PTYs still registered with the native session manager.
pub fn live_sessions(state: State<'_, SessionManager>) -> Vec<String> {
    state.sessions.lock().unwrap().keys().cloned().collect()
}

#[tauri::command]
/// Return the complete working-tree diff against HEAD for a session directory.
pub fn git_diff(cwd: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--no-color", "HEAD"])
        .current_dir(expand_tilde(&cwd))
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(Serialize)]
pub struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
/// List a directory with folders first and case-insensitive name ordering.
pub fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = expand_tilde(&path);
    let mut out: Vec<DirEntryInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
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

/// Repo root + porcelain status (paths relative to the root).
#[tauri::command]
pub fn git_status(cwd: String) -> Result<GitStatusResult, String> {
    let dir = expand_tilde(&cwd);
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
#[tauri::command]
pub fn git_file_diff(cwd: String, path: String) -> Result<String, String> {
    let out = Command::new("git")
        .args(["diff", "--no-color", "-U0", "HEAD", "--", &path])
        .current_dir(expand_tilde(&cwd))
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Run a user-configured credential command through a login shell and return
/// its stdout (e.g. `claude default-credential-export`, corporate token CLIs).
#[tauri::command]
pub async fn run_credential_command(cmd: String) -> Result<String, String> {
    let out = tauri::async_runtime::spawn_blocking(move || {
        Command::new("/bin/sh").args(["-lc", &cmd]).output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("credential command failed to run: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "credential command exited with {}: {}",
            out.status.code().unwrap_or(-1),
            stderr
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
/// Read one UTF-8 text file after expanding its home-directory shorthand.
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(expand_tilde(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
/// Replace one file with UTF-8 text after expanding its path.
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(expand_tilde(&path), contents).map_err(|e| e.to_string())
}

#[tauri::command]
/// Persist the serialized frontend state under Tauri's application-data directory.
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("conductor-state.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
/// Load persisted frontend state, treating a missing file as a fresh install.
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(dir.join("conductor-state.json")) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_login_executable, session_launch_spec};

    #[test]
    /// Resolve a guaranteed system shell through an explicit path.
    fn resolves_absolute_terminal_shell() {
        assert_eq!(resolve_login_executable("/bin/sh").unwrap(), "/bin/sh");
    }

    #[test]
    /// Reject a missing shell instead of silently falling back to another
    /// executable.
    fn rejects_missing_terminal_shell() {
        assert!(resolve_login_executable("yaam-shell-that-does-not-exist").is_err());
    }

    #[test]
    /// Direct terminal mode bypasses the generic command wrapper.
    fn builds_direct_terminal_launch_spec() {
        let (program, args, shell_env) =
            session_launch_spec("ignored", Some("/bin/sh")).unwrap();
        assert_eq!(program, "/bin/sh");
        assert_eq!(args, ["-l", "-i"]);
        assert_eq!(shell_env.as_deref(), Some("/bin/sh"));
    }

    #[test]
    /// Arbitrary commands retain login-shell parsing and do not rewrite SHELL.
    fn builds_wrapped_command_launch_spec() {
        let (program, args, shell_env) = session_launch_spec("printf hello", None).unwrap();
        assert_eq!(program, "/bin/sh");
        assert_eq!(args, ["-lc", "printf hello"]);
        assert_eq!(shell_env, None);
    }
}
