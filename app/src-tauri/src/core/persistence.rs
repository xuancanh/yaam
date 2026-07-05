//! Durable state storage: atomic file writes with a rolling backup, split into
//! a low-churn main partition, optional named partitions, and one file per
//! session. All paths live under Tauri's application-data directory.
use tauri::{AppHandle, Manager};

/// Restrict a partition / session name to a safe file stem (no separators or
/// traversal).
fn safe_stem(name: &str) -> Result<String, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid name: {name}"));
    }
    Ok(format!("{name}.json"))
}

/// Atomic write to an absolute path: unique temp file + fsync + rename, rotating
/// the previous copy to `<path>.bak`. Temp-file + rename means a crash mid-write
/// can never truncate the only good copy, and a unique temp name keeps
/// concurrent writers from sharing one scratch path.
fn atomic_write(path: &std::path::Path, json: &str) -> Result<(), String> {
    use std::io::Write;
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

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn sessions_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(data_dir(app)?.join("sessions"))
}

/// Persist the main state partition (`conductor-state.json`).
pub fn save_main(app: &AppHandle, json: &str) -> Result<(), String> {
    atomic_write(&data_dir(app)?.join("conductor-state.json"), json)
}

/// Load the main partition, falling back to its backup; a missing file is a
/// fresh install.
pub fn load_main(app: &AppHandle) -> Result<Option<String>, String> {
    read_with_backup(&data_dir(app)?.join("conductor-state.json"), true)
}

/// Return the main partition's previous snapshot (the `.bak`).
pub fn load_main_backup(app: &AppHandle) -> Result<Option<String>, String> {
    read_with_backup(&data_dir(app)?.join("conductor-state.json.bak"), false)
}

/// Persist a named partition (e.g. the legacy `sessions`) as `<name>.json`.
pub fn save_partition(app: &AppHandle, name: &str, json: &str) -> Result<(), String> {
    atomic_write(&data_dir(app)?.join(safe_stem(name)?), json)
}

/// Load a named partition, falling back to its `.bak`.
pub fn load_partition(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    read_with_backup(&data_dir(app)?.join(safe_stem(name)?), true)
}

/// Persist one session (agent) to its own file, `sessions/<id>.json`.
pub fn save_session(app: &AppHandle, id: &str, json: &str) -> Result<(), String> {
    atomic_write(&sessions_dir(app)?.join(safe_stem(id)?), json)
}

/// Delete one session's file (and its backup).
pub fn remove_session(app: &AppHandle, id: &str) -> Result<(), String> {
    let file = safe_stem(id)?;
    let dir = sessions_dir(app)?;
    let _ = std::fs::remove_file(dir.join(&file));
    let _ = std::fs::remove_file(dir.join(format!("{file}.bak")));
    Ok(())
}

/// Load every persisted session file. Returns each file's JSON; a `.bak` is
/// used only when the primary is missing. Unreadable files are skipped.
pub fn load_sessions(app: &AppHandle) -> Result<Vec<String>, String> {
    let dir = sessions_dir(app)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    let mut seen_stems = std::collections::HashSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
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
