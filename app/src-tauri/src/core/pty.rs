//! PTY session engine: owns the live child processes, streams their output to
//! the frontend, and reaps them on exit. This is the domain logic behind the
//! session commands — the managed `SessionManager` state lives here.
use crate::core::util::expand_tilde;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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
        self.sessions.lock().unwrap().insert(
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
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
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
}
