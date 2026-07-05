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
    /// distinguishes a resumed session reusing the same id from the one whose
    /// exit thread is still in flight
    generation: u64,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    next_generation: std::sync::atomic::AtomicU64,
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

    let generation = state
        .next_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.sessions.lock().unwrap().insert(
        id.clone(),
        SessionHandle {
            master: pair.master,
            writer,
            killer,
            generation,
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
        let mut sessions = mgr.sessions.lock().unwrap();
        // a stop + relaunch can reuse this id before we get here — never
        // remove (or report exit for) a newer session's handle
        let stale = sessions
            .get(&id_exit)
            .map(|h| h.generation != generation)
            .unwrap_or(false);
        if !stale {
            sessions.remove(&id_exit);
        }
        drop(sessions);
        if !stale {
            let _ = app_exit.emit("session-exit", ExitEvent { id: id_exit, code });
        }
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
/// Collect candidate session files whose creation time falls in [since, until].
/// Creation time (not mtime) is used so a session another conversation keeps
/// appending to can't shadow the file our child just created.
fn files_in_window(
    dir: &std::path::Path,
    since_ms: u64,
    until_ms: u64,
    recurse: bool,
    matches: &dyn Fn(&std::path::Path) -> bool,
    out: &mut Vec<(u64, std::path::PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recurse {
                files_in_window(&path, since_ms, until_ms, true, matches, out);
            }
            continue;
        }
        if !matches(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let created = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        if let Some(created) = created {
            if created >= since_ms && created <= until_ms {
                out.push((created, path));
            }
        }
    }
}

/// Turn a session file path into the CLI's resume id for the given kind.
fn derive_session_id(kind: &str, path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    match kind {
        // ~/.codex/sessions/.../rollout-<ts>-<uuid>.jsonl → trailing 36-char UUID
        "codex" => {
            if stem.len() >= 36 {
                Some(stem[stem.len() - 36..].to_string())
            } else {
                Some(stem)
            }
        }
        // claude: <id>.jsonl ; opencode: ses_<id>.json — the stem is the id
        _ => Some(stem),
    }
}

/// Detect the session id a CLI created after `since_ms`, so it can be resumed
/// later. Fix for shared/non-cwd-scoped stores (codex, opencode) and multiple
/// concurrent sessions: pick the EARLIEST file in the window whose id isn't
/// already claimed by another live session, rather than the newest in the dir.
#[tauri::command]
pub fn detect_cli_session(
    kind: String,
    cwd: Option<String>,
    since_ms: f64,
    exclude: Vec<String>,
) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let since = since_ms as u64;
    // window upper bound: the file appears within seconds of spawn; a generous
    // cap keeps a much-later sibling's file from being adopted by a late probe
    let until = since.saturating_add(180_000);

    let (dir, recurse, matcher): (std::path::PathBuf, bool, Box<dyn Fn(&std::path::Path) -> bool>) =
        match kind.as_str() {
            "claude" => {
                // ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl (cwd-scoped)
                let base = expand_tilde(&cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| home.clone()));
                let encoded = base.replace(['/', '.'], "-");
                let project = std::path::PathBuf::from(&home).join(".claude/projects").join(encoded);
                (project, false, Box::new(|p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl")))
            }
            "codex" => {
                // ~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl (NOT cwd-scoped)
                let dir = std::path::PathBuf::from(&home).join(".codex/sessions");
                (dir, true, Box::new(|p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl")))
            }
            "opencode" => {
                // ~/.local/share/opencode/storage/**/ses_<id>.json (NOT cwd-scoped;
                // sessions live in SQLite + these per-session json fragments)
                let dir = std::path::PathBuf::from(&home).join(".local/share/opencode/storage");
                (dir, true, Box::new(|p: &std::path::Path| {
                    p.extension().and_then(|e| e.to_str()) == Some("json")
                        && p.file_stem().and_then(|s| s.to_str()).map(|s| s.starts_with("ses_")).unwrap_or(false)
                }))
            }
            _ => return None,
        };

    let mut candidates: Vec<(u64, std::path::PathBuf)> = Vec::new();
    files_in_window(&dir, since, until, recurse, &matcher, &mut candidates);
    // earliest first: the first file to appear after we spawned is most likely ours
    candidates.sort_by_key(|(created, _)| *created);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (_, path) in candidates {
        let Some(id) = derive_session_id(&kind, &path) else { continue };
        // one id can map to several files (opencode writes several fragments);
        // consider each id once, in earliest-creation order
        if !seen.insert(id.clone()) {
            continue;
        }
        if !exclude.contains(&id) {
            return Some(id);
        }
    }
    None
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

#[derive(serde::Serialize)]
pub struct ExecResult {
    pub code: i32,
    pub output: String,
}

/// One-shot shell execution for chat agents: run a command, capture merged
/// output (capped), enforce a wall-clock timeout by killing the child.
#[tauri::command]
pub async fn exec_command(
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
        let out_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = stdout_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });
        let err_thread = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = stderr_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });
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
        let stdout_buf = out_thread.join().unwrap_or_default();
        let stderr_buf = err_thread.join().unwrap_or_default();
        let mut text = String::from_utf8_lossy(&stdout_buf).to_string();
        let err = String::from_utf8_lossy(&stderr_buf);
        if !err.trim().is_empty() {
            if !text.trim().is_empty() {
                text.push('\n');
            }
            text.push_str(&err);
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
        const CAP: usize = 40_000;
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
/// Read one UTF-8 text file after expanding its home-directory shorthand.
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(expand_tilde(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
/// Create or replace one file with UTF-8 text, creating parent directories.
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let full = expand_tilde(&path);
    if let Some(parent) = std::path::Path::new(&full).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&full, contents).map_err(|e| e.to_string())
}

/// Restrict a partition name to a safe file stem (no separators / traversal).
fn partition_file(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid partition name: {name}"));
    }
    Ok(format!("{name}.json"))
}

/// Atomic write to an absolute path: unique temp file + fsync + rename, rotating
/// the previous copy to `<path>.bak`. Temp-file + rename means a crash mid-write
/// can never truncate the only good copy, and a unique temp name keeps
/// concurrent writers from sharing one scratch path.
fn atomic_write(path: &std::path::Path, json: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path.file_name().and_then(|n| n.to_str()).ok_or("bad file name")?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = parent.join(format!("{name}.{nonce}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    let bak = parent.join(format!("{name}.bak"));
    if path.exists() {
        let _ = std::fs::rename(path, &bak);
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Read a file, optionally falling back to its sibling `.bak`.
fn read_with_backup(path: &std::path::Path, with_backup: bool) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if with_backup {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                let bak = path.with_file_name(format!("{name}.bak"));
                match std::fs::read_to_string(bak) {
                    Ok(s) => Ok(Some(s)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(e.to_string()),
                }
            } else {
                Ok(None)
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

fn write_partition(app: &AppHandle, file: &str, json: &str) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    atomic_write(&dir.join(file), json)
}

fn read_partition(app: &AppHandle, file: &str, with_backup: bool) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    read_with_backup(&dir.join(file), with_backup)
}

#[tauri::command]
/// Persist the main state partition (`conductor-state.json`).
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    write_partition(&app, "conductor-state.json", &json)
}

#[tauri::command]
/// Load the main state partition, falling back to its backup, treating a
/// missing file as a fresh install.
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    read_partition(&app, "conductor-state.json", true)
}

#[tauri::command]
/// Return the main partition's previous snapshot (the `.bak`), for recovery
/// when the primary file exists but the frontend can't parse it.
pub fn load_state_backup(app: AppHandle) -> Result<Option<String>, String> {
    read_partition(&app, "conductor-state.json.bak", false)
}

#[tauri::command]
/// Persist a named state partition (e.g. legacy `sessions`) as `<name>.json`.
pub fn save_partition(app: AppHandle, name: String, json: String) -> Result<(), String> {
    write_partition(&app, &partition_file(&name)?, &json)
}

#[tauri::command]
/// Load a named state partition, falling back to its `.bak`.
pub fn load_partition(app: AppHandle, name: String) -> Result<Option<String>, String> {
    read_partition(&app, &partition_file(&name)?, true)
}

/// Directory holding one JSON file per session (keeps a chat/terminal update
/// from rewriting a single monolithic sessions blob).
fn sessions_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("sessions"))
}

#[tauri::command]
/// Persist one session (agent) to its own file, `sessions/<id>.json`.
pub fn save_session(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let file = partition_file(&id)?; // reuse the safe-name guard (no separators/traversal)
    atomic_write(&sessions_dir(&app)?.join(file), &json)
}

#[tauri::command]
/// Delete one session's file (and its backup).
pub fn remove_session(app: AppHandle, id: String) -> Result<(), String> {
    let file = partition_file(&id)?;
    let dir = sessions_dir(&app)?;
    let _ = std::fs::remove_file(dir.join(&file));
    let _ = std::fs::remove_file(dir.join(format!("{file}.bak")));
    Ok(())
}

#[tauri::command]
/// Load every persisted session file. Returns each file's JSON; a `.bak` is
/// used only when the primary is missing. Unreadable files are skipped.
pub fn load_sessions(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = sessions_dir(&app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    let mut seen_stems = std::collections::HashSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        // primary files only: <id>.json (skip <id>.json.bak and *.tmp)
        if !name.ends_with(".json") || name.ends_with(".tmp") {
            continue;
        }
        if let Ok(Some(s)) = read_with_backup(&path, false) {
            seen_stems.insert(name.trim_end_matches(".json").to_string());
            out.push(s);
        }
    }
    // recover any session whose primary is missing but a .bak survives
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if let Some(stem) = name.strip_suffix(".json.bak") {
                if !seen_stems.contains(stem) {
                    if let Ok(s) = std::fs::read_to_string(&path) {
                        out.push(s);
                    }
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{derive_session_id, resolve_login_executable, session_launch_spec};
    use std::path::Path;

    #[test]
    /// Codex ids are the trailing 36-char UUID of the rollout filename; claude
    /// and opencode ids are the whole file stem.
    fn derives_session_ids_per_cli() {
        assert_eq!(
            derive_session_id("codex", Path::new(
                "/x/rollout-2026-03-29T22-06-43-019d3d23-176a-7663-baaa-fdc8cef1e988.jsonl")),
            Some("019d3d23-176a-7663-baaa-fdc8cef1e988".to_string()),
        );
        assert_eq!(
            derive_session_id("claude", Path::new("/x/abc-123-def.jsonl")),
            Some("abc-123-def".to_string()),
        );
        assert_eq!(
            derive_session_id("opencode", Path::new("/x/ses_1a8d3093dffeV2rBjv.json")),
            Some("ses_1a8d3093dffeV2rBjv".to_string()),
        );
    }

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
