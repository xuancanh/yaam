//! Keep-awake: hold a system idle-sleep assertion while agent sessions work,
//! so a locked/dark screen doesn't pause them. macOS: a `caffeinate -i -w
//! <our pid>` child holds the IOKit assertion and exits on its own if this
//! process dies, so an app crash can never leave the Mac permanently awake.
//! The display still sleeps and locks normally — only *system* idle sleep is
//! blocked, and a closed lid still sleeps the machine (OS policy; no
//! assertion overrides it). Other platforms: accepted but inert for now.
use std::process::Child;
use std::sync::Mutex;

#[derive(Default)]
pub struct PowerState {
    holder: Mutex<Option<Child>>,
}

impl Drop for PowerState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.holder.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn stop_holder(state: &PowerState) {
    let mut guard = state.holder.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(target_os = "macos")]
fn start_holder(state: &PowerState) -> Result<(), String> {
    let mut guard = state.holder.lock().unwrap_or_else(|p| p.into_inner());
    // already holding (and the child is still alive) — nothing to do
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                *guard = None;
            }
        }
    }
    let child = std::process::Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start caffeinate: {e}"))?;
    *guard = Some(child);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn start_holder(_state: &PowerState) -> Result<(), String> {
    // no-op elsewhere until a native inhibitor is wired up
    Ok(())
}

/// Turn the idle-sleep assertion on or off (idempotent both ways).
#[tauri::command]
pub fn keep_awake_set(state: tauri::State<'_, PowerState>, on: bool) -> Result<bool, String> {
    if on {
        start_holder(&state)?;
    } else {
        stop_holder(&state);
    }
    Ok(on)
}

/// True while the assertion child is alive (the UI indicator's source of truth).
#[tauri::command]
pub fn keep_awake_active(state: tauri::State<'_, PowerState>) -> bool {
    let mut guard = state.holder.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}
