use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct SessionManager {
    children: Mutex<HashMap<String, Child>>,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    stream: String, // "out" | "err" | "sys"
    line: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

fn pump<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    id: String,
    stream: &'static str,
    reader: R,
) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(line) => {
                    let _ = app.emit(
                        "session-output",
                        OutputEvent {
                            id: id.clone(),
                            stream: stream.into(),
                            line,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });
}

#[tauri::command]
pub fn spawn_session(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1");
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn `{command}`: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        pump(app.clone(), id.clone(), "out", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        pump(app.clone(), id.clone(), "err", stderr);
    }

    state.children.lock().unwrap().insert(id.clone(), child);

    // Reap the process and notify the frontend when it exits.
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let mgr = app2.state::<SessionManager>();
        let mut children = mgr.children.lock().unwrap();
        match children.get_mut(&id2).map(|c| c.try_wait()) {
            Some(Ok(Some(status))) => {
                children.remove(&id2);
                drop(children);
                let _ = app2.emit(
                    "session-exit",
                    ExitEvent {
                        id: id2.clone(),
                        code: status.code(),
                    },
                );
                break;
            }
            Some(Ok(None)) => continue,
            _ => break, // killed elsewhere or wait failed
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_session(
    state: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut children = state.children.lock().unwrap();
    let child = children.get_mut(&id).ok_or("no such session")?;
    let stdin = child.stdin.as_mut().ok_or("stdin closed")?;
    stdin
        .write_all(data.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_session(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    let mut children = state.children.lock().unwrap();
    if let Some(mut child) = children.remove(&id) {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
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
