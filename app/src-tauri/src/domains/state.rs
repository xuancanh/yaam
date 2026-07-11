//! Durable state storage: atomic file writes with a rolling backup, split into
//! a low-churn main partition, optional named partitions, and one file per
//! session. All paths live under Tauri's application-data directory.
use tauri::{AppHandle, Manager};

const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_BYTES: usize = 16 * 1024 * 1024;

/// Restrict a partition / session name to a safe file stem (no separators or
/// traversal).
fn safe_stem(name: &str) -> Result<String, String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
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
    use std::sync::{Mutex, OnceLock};
    static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let _guard = WRITE_LOCK.get_or_init(|| Mutex::new(())).lock().map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("path has no parent directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("bad file name")?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = parent.join(format!("{name}.{nonce}-{seq}.tmp"));
    {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&tmp).map_err(|e| e.to_string())?;
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
        match std::fs::remove_file(&bak) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => { let _ = std::fs::remove_file(&tmp); return Err(e.to_string()); }
        }
        if let Err(e) = std::fs::rename(path, &bak) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a file, optionally falling back to its sibling `.bak`.
fn read_with_backup(path: &std::path::Path, with_backup: bool) -> Result<Option<String>, String> {
    let read_bounded = |candidate: &std::path::Path| -> Result<String, std::io::Error> {
        let meta = std::fs::metadata(candidate)?;
        if meta.len() > MAX_STATE_BYTES as u64 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "state file exceeds 64 MB"));
        }
        std::fs::read_to_string(candidate)
    };
    match read_bounded(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if with_backup {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default();
                let bak = path.with_file_name(format!("{name}.bak"));
                match read_bounded(&bak) {
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
    if json.len() > MAX_STATE_BYTES { return Err("main state exceeds 64 MB".to_string()); }
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
fn save_partition_impl(app: &AppHandle, name: &str, json: &str) -> Result<(), String> {
    if json.len() > MAX_STATE_BYTES { return Err("state partition exceeds 64 MB".to_string()); }
    atomic_write(&data_dir(app)?.join(safe_stem(name)?), json)
}

/// Load a named partition, falling back to its `.bak`.
fn load_partition_impl(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    read_with_backup(&data_dir(app)?.join(safe_stem(name)?), true)
}

/// Persist one session (agent) to its own file, `sessions/<id>.json`.
fn save_session_impl(app: &AppHandle, id: &str, json: &str) -> Result<(), String> {
    if json.len() > MAX_SESSION_BYTES { return Err("session state exceeds 16 MB".to_string()); }
    atomic_write(&sessions_dir(app)?.join(safe_stem(id)?), json)
}

/// Delete one session's file (and its backup).
fn remove_session_impl(app: &AppHandle, id: &str) -> Result<(), String> {
    let file = safe_stem(id)?;
    let dir = sessions_dir(app)?;
    for path in [dir.join(&file), dir.join(format!("{file}.bak"))] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn load_session_files(dir: &std::path::Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out = Vec::new();
    let mut seen_stems = std::collections::HashSet::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
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
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
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

/// Load every persisted session file. Returns each file's JSON; a `.bak` is
/// used only when the primary is missing. Unreadable files are skipped.
fn load_sessions_impl(app: &AppHandle) -> Result<Vec<String>, String> {
    load_session_files(&sessions_dir(app)?)
}

#[tauri::command]
pub fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    save_main(&app, &json)
}

#[tauri::command]
pub fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    load_main(&app)
}

#[tauri::command]
pub fn load_state_backup(app: AppHandle) -> Result<Option<String>, String> {
    load_main_backup(&app)
}

#[tauri::command]
pub fn save_partition(app: AppHandle, name: String, json: String) -> Result<(), String> {
    save_partition_impl(&app, &name, &json)
}

#[tauri::command]
pub fn load_partition(app: AppHandle, name: String) -> Result<Option<String>, String> {
    load_partition_impl(&app, &name)
}

#[tauri::command]
pub fn save_session(app: AppHandle, id: String, json: String) -> Result<(), String> {
    save_session_impl(&app, &id, &json)
}

#[tauri::command]
pub fn remove_session(app: AppHandle, id: String) -> Result<(), String> {
    remove_session_impl(&app, &id)
}

#[tauri::command]
pub fn load_sessions(app: AppHandle) -> Result<Vec<String>, String> {
    load_sessions_impl(&app)
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, load_session_files, read_with_backup, safe_stem, MAX_STATE_BYTES};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("yaam-{label}-{}-{id}", std::process::id()));
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
    fn safe_stem_accepts_expected_identifiers() {
        assert_eq!(
            safe_stem("session-42_alpha").unwrap(),
            "session-42_alpha.json"
        );
        assert_eq!(safe_stem("A9").unwrap(), "A9.json");
    }

    #[test]
    fn safe_stem_rejects_empty_traversal_and_non_ascii_names() {
        for name in ["", "../state", "a/b", "a.b", "with space", "café"] {
            assert!(safe_stem(name).is_err(), "accepted unsafe name: {name:?}");
        }
    }

    #[test]
    fn atomic_write_rotates_the_previous_snapshot() {
        let dir = TestDir::new("atomic-write");
        let path = dir.path().join("state.json");

        atomic_write(&path, r#"{"version":1}"#).unwrap();
        atomic_write(&path, r#"{"version":2}"#).unwrap();
        atomic_write(&path, r#"{"version":3}"#).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"version":3}"#);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("state.json.bak")).unwrap(),
            r#"{"version":2}"#
        );
        assert!(!std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_restricts_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TestDir::new("permissions");
        let path = dir.path().join("state.json");
        atomic_write(&path, "{}").unwrap();

        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn read_with_backup_recovers_a_missing_primary() {
        let dir = TestDir::new("backup-read");
        let path = dir.path().join("state.json");
        std::fs::write(dir.path().join("state.json.bak"), "backup").unwrap();

        assert_eq!(
            read_with_backup(&path, true).unwrap().as_deref(),
            Some("backup")
        );
        assert_eq!(read_with_backup(&path, false).unwrap(), None);
    }

    #[test]
    fn state_reads_reject_oversized_files_before_allocating_them() {
        let dir = TestDir::new("oversized-read");
        let path = dir.path().join("state.json");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_STATE_BYTES as u64 + 1).unwrap();
        assert!(read_with_backup(&path, false).unwrap_err().contains("exceeds 64 MB"));
    }

    #[test]
    fn load_session_files_prefers_primaries_and_recovers_orphaned_backups() {
        let dir = TestDir::new("sessions");
        std::fs::write(dir.path().join("primary.json"), "primary-current").unwrap();
        std::fs::write(dir.path().join("primary.json.bak"), "primary-old").unwrap();
        std::fs::write(dir.path().join("recovered.json.bak"), "recovered").unwrap();
        std::fs::write(dir.path().join("ignored.json.1.tmp"), "temporary").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not-json").unwrap();

        let mut loaded = load_session_files(dir.path()).unwrap();
        loaded.sort();

        assert_eq!(loaded, vec!["primary-current", "recovered"]);
    }

    #[test]
    fn load_session_files_treats_a_missing_directory_as_empty() {
        let dir = TestDir::new("missing-sessions");
        let missing = dir.path().join("does-not-exist");
        assert!(load_session_files(&missing).unwrap().is_empty());
    }
}
