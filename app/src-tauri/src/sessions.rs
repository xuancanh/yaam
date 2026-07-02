use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
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
pub fn spawn_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    command: String,
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

    // Run through a login shell so quoting works and the user's PATH
    // (nvm, homebrew, cargo, …) is available — GUI apps don't inherit it.
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-lc", &command]);
    cmd.env("TERM", "xterm-256color");
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
        .map_err(|e| format!("failed to spawn `{command}`: {e}"))?;
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
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut handle) = sessions.remove(&id) {
        let _ = handle.killer.kill();
    }
    Ok(())
}

#[tauri::command]
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

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("conductor-state.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match std::fs::read_to_string(dir.join("conductor-state.json")) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
