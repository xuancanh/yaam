//! PTY session engine: owns the live child processes, streams their output to
//! the frontend, and reaps them on exit. This is the domain logic behind the
//! session commands — the managed `SessionManager` state lives here.
use crate::util::expand_tilde;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
        .rfind(|line| !line.is_empty())
        .unwrap_or_default()
        .to_string();
    if !out.status.success() || resolved.is_empty() || !std::path::Path::new(&resolved).is_file() {
        return Err(format!(
            "terminal shell not found in login PATH: {requested}"
        ));
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

impl SessionManager {
    /// Spawn a command or direct terminal shell and stream PTY events to React.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
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

        let generation = self
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        {
            let mut sessions = self.sessions.lock().unwrap();
            // Reusing a live id: explicitly shut the old process down first.
            // Merely dropping the replaced handle leaks the child (dropping the
            // killer does not terminate it). The exit reaper for the old
            // generation then sees the newer handle and stays quiet.
            if let Some(mut old) = sessions.remove(&id) {
                let _ = old.killer.kill();
            }
            sessions.insert(
                id.clone(),
                SessionHandle {
                    master: pair.master,
                    writer,
                    killer,
                    generation,
                },
            );
        }

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
                        let _ = app_out.emit(
                            "session-data",
                            DataEvent {
                                id: id_out.clone(),
                                data,
                            },
                        );
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

    /// Write text to a session's PTY writer and flush it immediately.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let handle = sessions.get_mut(id).ok_or("no such session")?;
        handle
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| handle.writer.flush())
            .map_err(|e| e.to_string())
    }

    /// Resize a session's PTY so terminal applications receive SIGWINCH.
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let handle = sessions.get(id).ok_or("no such session")?;
        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Remove a managed session and ask its child process to terminate.
    pub fn kill(&self, id: &str) {
        if let Some(mut handle) = self.sessions.lock().unwrap().remove(id) {
            let _ = handle.killer.kill();
        }
    }

    /// Ids of PTYs still registered with the manager.
    pub fn live_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

/// Collect candidate session files whose creation time falls in [since, until].
/// Creation time (not mtime) prevents an older, concurrently active session
/// from shadowing the file created by the process being detected.
fn files_in_window(
    dir: &std::path::Path,
    since_ms: u64,
    until_ms: u64,
    recurse: bool,
    matches: &dyn Fn(&std::path::Path) -> bool,
    out: &mut Vec<(u64, std::path::PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
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
        let Ok(meta) = entry.metadata() else {
            continue;
        };
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
        // ~/.codex/sessions/.../rollout-<ts>-<uuid>.jsonl -> trailing UUID
        "codex" if stem.len() >= 36 => Some(stem[stem.len() - 36..].to_string()),
        // Claude and OpenCode use the complete file stem.
        _ => Some(stem),
    }
}

fn select_session_id(
    kind: &str,
    candidates: &mut [(u64, std::path::PathBuf)],
    exclude: &[String],
) -> Option<String> {
    candidates.sort_by_key(|(created, _)| *created);
    let mut seen = std::collections::HashSet::new();
    for (_, path) in candidates {
        let Some(id) = derive_session_id(kind, path) else {
            continue;
        };
        if seen.insert(id.clone()) && !exclude.contains(&id) {
            return Some(id);
        }
    }
    None
}

type SessionStoreSpec = (
    std::path::PathBuf,
    bool,
    Box<dyn Fn(&std::path::Path) -> bool>,
);

/// Detect the session id a CLI created after `since_ms`.
fn detect_cli_session_impl(
    kind: &str,
    cwd: Option<String>,
    since_ms: f64,
    exclude: &[String],
) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let since = since_ms as u64;
    let until = since.saturating_add(180_000);

    let (dir, recurse, matcher): SessionStoreSpec = match kind {
        "claude" => {
            let base = expand_tilde(
                &cwd.filter(|c| !c.is_empty())
                    .unwrap_or_else(|| home.clone()),
            );
            let encoded = base.replace(['/', '.'], "-");
            let project = std::path::PathBuf::from(&home)
                .join(".claude/projects")
                .join(encoded);
            (
                project,
                false,
                Box::new(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
            )
        }
        "codex" => (
            std::path::PathBuf::from(&home).join(".codex/sessions"),
            true,
            Box::new(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl")),
        ),
        "opencode" => (
            std::path::PathBuf::from(&home).join(".local/share/opencode/storage"),
            true,
            Box::new(|p| {
                p.extension().and_then(|e| e.to_str()) == Some("json")
                    && p.file_stem()
                        .and_then(|s| s.to_str())
                        .map(|s| s.starts_with("ses_"))
                        .unwrap_or(false)
            }),
        ),
        _ => return None,
    };

    let mut candidates = Vec::new();
    files_in_window(&dir, since, until, recurse, &matcher, &mut candidates);
    select_session_id(kind, &mut candidates, exclude)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    state.spawn(app, id, command, terminal_shell, cwd, rows, cols)
}

#[tauri::command]
pub fn write_session(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, SessionManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.resize(&id, rows, cols)
}

#[tauri::command]
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    state.kill(&id);
    Ok(())
}

#[tauri::command]
pub fn live_sessions(state: State<'_, SessionManager>) -> Vec<String> {
    state.live_ids()
}

#[tauri::command]
pub fn detect_cli_session(
    kind: String,
    cwd: Option<String>,
    since_ms: f64,
    exclude: Vec<String>,
) -> Option<String> {
    detect_cli_session_impl(&kind, cwd, since_ms, &exclude)
}

#[cfg(test)]
mod tests {
    use super::{
        derive_session_id, resolve_login_executable, select_session_id, session_launch_spec,
    };
    use std::path::{Path, PathBuf};

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
    /// A wrapped command runs through `/bin/sh -lc` with no SHELL override.
    fn builds_wrapped_command_launch_spec() {
        let (exe, args, shell) = session_launch_spec("echo hi", None).unwrap();
        assert_eq!(exe, "/bin/sh");
        assert_eq!(args, vec!["-lc".to_string(), "echo hi".to_string()]);
        assert!(shell.is_none());
    }

    #[test]
    /// A terminal shell launches directly as a login+interactive shell.
    fn builds_direct_terminal_launch_spec() {
        let (exe, args, shell) = session_launch_spec("", Some("/bin/sh")).unwrap();
        assert_eq!(exe, "/bin/sh");
        assert_eq!(args, vec!["-l".to_string(), "-i".to_string()]);
        assert_eq!(shell.as_deref(), Some("/bin/sh"));
    }

    #[test]
    fn derives_session_ids_per_cli() {
        assert_eq!(
            derive_session_id(
                "codex",
                Path::new(
                    "/x/rollout-2026-03-29T22-06-43-019d3d23-176a-7663-baaa-fdc8cef1e988.jsonl"
                )
            ),
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
    fn selects_the_earliest_unclaimed_session() {
        let mut candidates = vec![
            (30, PathBuf::from("/x/third.jsonl")),
            (10, PathBuf::from("/x/first.jsonl")),
            (20, PathBuf::from("/x/second.jsonl")),
        ];
        let excluded = vec!["first".to_string()];

        assert_eq!(
            select_session_id("claude", &mut candidates, &excluded).as_deref(),
            Some("second")
        );
    }

    #[test]
    fn does_not_select_an_excluded_duplicate_id() {
        let id = "019d3d23-176a-7663-baaa-fdc8cef1e988";
        let mut candidates = vec![
            (10, PathBuf::from(format!("/x/rollout-a-{id}.jsonl"))),
            (20, PathBuf::from(format!("/x/rollout-b-{id}.jsonl"))),
        ];

        assert_eq!(
            select_session_id("codex", &mut candidates, &[id.to_string()]),
            None
        );
    }
}
