//! Filesystem and one-shot process execution used by chat agents and the file
//! pane: directory listing, text read/write, credential commands, and a
//! timeout-bounded shell exec.
use crate::util::expand_tilde;
use serde::Serialize;
use std::io::Read;
use std::process::Command;

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
fn list_dir_impl(path: &str) -> Result<Vec<DirEntryInfo>, String> {
    let dir = expand_tilde(path);
    let mut out: Vec<DirEntryInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
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

/// Read one UTF-8 text file after expanding its home-directory shorthand.
fn read_text_impl(path: &str) -> Result<String, String> {
    std::fs::read_to_string(expand_tilde(path)).map_err(|e| e.to_string())
}

/// Create or replace one file with UTF-8 text, creating parent directories.
fn write_text_impl(path: &str, contents: &str) -> Result<(), String> {
    let full = expand_tilde(path);
    if let Some(parent) = std::path::Path::new(&full).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&full, contents).map_err(|e| e.to_string())
}

/// Run a user-configured credential command through a login shell and return
/// its stdout (e.g. `claude default-credential-export`, corporate token CLIs).
async fn run_credential_command_impl(cmd: String) -> Result<String, String> {
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
pub fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    list_dir_impl(&path)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    read_text_impl(&path)
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_text_impl(&path, &contents)
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
        exec_command_impl, list_dir_impl, read_text_impl, run_credential_command_impl,
        write_text_impl,
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

        write_text_impl(&path, "hello 世界").unwrap();

        assert_eq!(read_text_impl(&path).unwrap(), "hello 世界");
    }

    #[test]
    fn list_dir_sorts_directories_first_then_names_case_insensitively() {
        let dir = TestDir::new("listing");
        std::fs::write(dir.path().join("beta.txt"), "").unwrap();
        std::fs::write(dir.path().join("Alpha.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("z-dir")).unwrap();
        std::fs::create_dir(dir.path().join("A-dir")).unwrap();

        let entries = list_dir_impl(&dir.path().to_string_lossy()).unwrap();
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
}
