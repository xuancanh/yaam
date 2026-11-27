//! Small helpers shared across backend domains.

use std::io::Read;
use std::process::Command;

/// Expand a leading home-directory shorthand before filesystem or process use.
pub fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

/// Claude Code's per-project directory for a working folder:
/// `~/.claude/projects/<cwd with every non-alphanumeric char as '-'>`.
/// (Not just `/` and `.`: `my_app` is stored as `my-app`.) Claude truncates
/// very long encodings and appends a hash; callers that need an exact file
/// should fall back to `find_claude_transcript` when this directory is absent.
pub fn claude_project_dir(home: &str, cwd: &str) -> std::path::PathBuf {
    let base = expand_tilde(if cwd.is_empty() { home } else { cwd });
    let encoded: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    std::path::PathBuf::from(home).join(".claude/projects").join(encoded)
}

/// Locate `<session_id>.jsonl` in any Claude project directory (one level).
pub fn find_claude_transcript(home: &str, session_id: &str) -> Option<std::path::PathBuf> {
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(std::path::PathBuf::from(home).join(".claude/projects"))
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

/// Environment a parent Claude Code session exports to its children. YAAM is
/// often started from inside one (`npm run tauri dev` in a Claude terminal);
/// leaking these into spawned PTYs makes a nested `claude` treat itself as a
/// child of that session (shared session id / transcript on some versions).
pub const PARENT_AGENT_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
];

#[cfg(test)]
mod claude_dir_tests {
    use super::claude_project_dir;

    #[test]
    fn encodes_every_non_alphanumeric_char() {
        assert_eq!(
            claude_project_dir("/Users/u", "/Users/u/workspace/interview_prep.react"),
            std::path::PathBuf::from("/Users/u/.claude/projects/-Users-u-workspace-interview-prep-react")
        );
        assert_eq!(
            claude_project_dir("/Users/u", ""),
            std::path::PathBuf::from("/Users/u/.claude/projects/-Users-u")
        );
    }
}

// ── bounded subprocess execution ────────────────────────────────────────────

/// Generous wall-clock limit for git-family subprocesses (git.rs, worktree.rs):
/// lock contention or a hung fsmonitor must surface as an error the frontend
/// can show, not hang the IPC call forever.
pub(crate) const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Tail cap per output pipe for git-family subprocesses, consistent with
/// exec_command's. A giant diff keeps its tail with a truncation marker
/// instead of marshalling unbounded bytes across the bridge.
pub(crate) const GIT_OUTPUT_CAP: usize = 40_000;

/// Run blocking work on the blocking pool from an async command. A sync Tauri
/// command runs on the main thread, so disk scans, process spawns, keychain
/// prompts and index commits there freeze the whole window.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Result of a bounded subprocess run.
#[derive(Debug)]
pub(crate) struct BoundedOutput {
    /// exit code; `None` when the process died by signal
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// either pipe exceeded the cap and was tail-truncated
    pub truncated: bool,
}

/// A pipe drained on its own thread into a capped tail buffer. Shared, so a
/// caller can take what has arrived without waiting for EOF: a backgrounded
/// grandchild (`npm run dev &`) inherits the pipe and keeps it open long after
/// the command itself exited, and joining the reader used to hang forever.
#[derive(Default)]
struct TailBuf {
    data: Vec<u8>,
    truncated: bool,
}

fn spawn_tail_reader<R: Read + Send + 'static>(
    pipe: Option<R>,
    cap: usize,
    done: std::sync::mpsc::Sender<()>,
) -> std::sync::Arc<std::sync::Mutex<TailBuf>> {
    let buf = std::sync::Arc::new(std::sync::Mutex::new(TailBuf::default()));
    let shared = buf.clone();
    std::thread::spawn(move || {
        if let Some(mut pipe) = pipe {
            let mut chunk = [0u8; 8192];
            loop {
                let n = match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut b = shared.lock().unwrap();
                b.data.extend_from_slice(&chunk[..n]);
                if b.data.len() > cap {
                    let excess = b.data.len() - cap;
                    b.data.drain(..excess);
                    b.truncated = true;
                }
            }
        }
        let _ = done.send(());
    });
    buf
}

/// How long to keep reading after the command exits, for output still in
/// flight. Past this, pipes held open by a background process are abandoned
/// (their reader threads finish whenever that process exits).
const PIPE_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Everything a bounded run observed.
pub(crate) struct Captured {
    /// `None` when the run timed out and was killed
    pub status: Option<std::process::ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

/// Run `command` (stdin closed, own process group) under a wall-clock
/// `timeout`, capturing a capped tail of stdout and stderr. On timeout the
/// whole process group is SIGKILLed and `status` is `None`. Never blocks past
/// `timeout + PIPE_GRACE`, even when a background job holds the pipes.
pub(crate) fn run_capture(
    command: &mut Command,
    timeout: std::time::Duration,
    cap: usize,
) -> Result<Captured, String> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        // own process group: a timeout kill reaches grandchildren too
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("failed to run: {e}"))?;
    let pid = child.id() as i32;
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let out = spawn_tail_reader(child.stdout.take(), cap, done_tx.clone());
    let err = spawn_tail_reader(child.stderr.take(), cap, done_tx);
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        if started.elapsed() >= timeout {
            // safe against pid reuse: the child is still unreaped (try_wait
            // returned None), so the pid cannot belong to anyone else
            #[cfg(unix)]
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    let deadline = std::time::Instant::now() + PIPE_GRACE;
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            break;
        }
    }
    let take = |b: &std::sync::Arc<std::sync::Mutex<TailBuf>>| {
        let mut g = b.lock().unwrap();
        (std::mem::take(&mut g.data), g.truncated)
    };
    let (stdout, t1) = take(&out);
    let (stderr, t2) = take(&err);
    Ok(Captured { status, stdout, stderr, truncated: t1 || t2 })
}

/// Run `command` to completion under a wall-clock `timeout`, keeping a capped
/// tail of each pipe. A timeout is an Err (the process group is killed).
pub(crate) fn run_bounded(
    command: &mut Command,
    timeout: std::time::Duration,
    cap: usize,
) -> Result<BoundedOutput, String> {
    let c = run_capture(command, timeout, cap)?;
    let Some(status) = c.status else {
        return Err(format!("command timed out after {}s", timeout.as_secs()));
    };
    Ok(BoundedOutput { code: status.code(), stdout: c.stdout, stderr: c.stderr, truncated: c.truncated })
}

// ── pid-reuse guards ────────────────────────────────────────────────────────

/// Liveness probe: true when `pid` still refers to a process we may signal.
/// Note this succeeds for zombies; callers that reap promptly (the session
/// reaper) shrink that window to nothing.
#[cfg(unix)]
pub(crate) fn process_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Microsecond-resolution start-time identity for a process, used to detect
/// pid recycling: a pid whose current start time differs from the recorded
/// one belongs to a different process. Implemented only where the platform
/// exposes it cheaply; elsewhere the guard degrades to liveness-only, leaving
/// a tiny (check-to-signal) race window — an acceptable tradeoff there.
#[cfg(target_os = "macos")]
pub(crate) fn process_start_time(pid: i32) -> Option<u64> {
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let wrote = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<libc::proc_bsdinfo>() as i32,
        );
        if wrote as usize != std::mem::size_of::<libc::proc_bsdinfo>() {
            return None;
        }
        Some(
            info.pbi_start_tvsec
                .saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec),
        )
    }
}

/// See the macOS implementation: unsupported platforms report no identity.
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn process_start_time(_pid: i32) -> Option<u64> {
    None
}

/// Signal `pid` only when it is still the process the caller means: it must be
/// alive AND, where the platform reports a start time, match the start time
/// recorded while the child was known to be ours. Guards a delayed force-kill
/// against the OS recycling the pid to an unrelated process. Returns true when
/// the signal was sent.
#[cfg(unix)]
pub(crate) fn signal_unless_recycled(pid: i32, expected_start: Option<u64>, sig: i32) -> bool {
    if !process_alive(pid) {
        return false;
    }
    if let Some(expected) = expected_start {
        if process_start_time(pid) != Some(expected) {
            return false;
        }
    }
    unsafe { libc::kill(pid, sig); }
    true
}

#[cfg(test)]
mod tests {
    use super::expand_tilde;

    #[test]
    fn expands_only_a_leading_home_shorthand() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/projects"), format!("{home}/projects"));
        assert_eq!(expand_tilde("work/~/notes"), "work/~/notes");
        assert_eq!(expand_tilde("~other/file"), "~other/file");
    }

    #[test]
    fn run_bounded_captures_output_and_exit_code() {
        let out = super::run_bounded(
            std::process::Command::new("/bin/sh").args(["-c", "printf stdout; printf stderr >&2; exit 7"]),
            std::time::Duration::from_secs(5),
            1024,
        )
        .unwrap();
        assert_eq!(out.code, Some(7));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "stdout");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "stderr");
        assert!(!out.truncated);
    }

    #[test]
    fn run_bounded_times_out_instead_of_hanging() {
        let err = super::run_bounded(
            std::process::Command::new("sleep").arg("2"),
            std::time::Duration::from_millis(50),
            1024,
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
    }

    #[test]
    fn run_bounded_truncates_to_the_capped_tail() {
        let out = super::run_bounded(
            std::process::Command::new("/bin/sh")
                .args(["-c", "yes x | head -n 10000; printf 'FINAL\\n'"]),
            std::time::Duration::from_secs(5),
            1024,
        )
        .unwrap();
        assert!(out.truncated);
        assert!(out.stdout.len() <= 1024);
        // the tail survives, not the flood
        assert!(String::from_utf8_lossy(&out.stdout).contains("FINAL"));
    }

    #[cfg(unix)]
    #[test]
    fn signal_guard_treats_a_dead_pid_as_a_no_op() {
        // beyond the platform pid ceiling, so deterministically unallocated —
        // no live process can be harmed if this ever regresses
        let dead = 4_000_000;
        assert!(!super::process_alive(dead));
        assert!(!super::signal_unless_recycled(dead, None, libc::SIGKILL));

        // a reaped child's pid is dead (and free to be recycled): the guard
        // must stay silent even with a recorded start-time identity
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let start = super::process_start_time(pid);
        let _ = child.kill();
        child.wait().unwrap();
        assert!(!super::signal_unless_recycled(pid, start, libc::SIGKILL));
    }

    #[cfg(unix)]
    #[test]
    fn signal_guard_honors_a_live_child_with_matching_identity() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let start = super::process_start_time(pid);
        assert!(super::process_alive(pid));
        // a start-time mismatch means the pid was recycled — never signal
        #[cfg(target_os = "macos")]
        {
            assert!(!super::signal_unless_recycled(pid, start.map(|s| s + 86_400_000_000), libc::SIGKILL));
            assert!(super::process_alive(pid), "a mismatched identity must not signal");
        }
        assert!(super::signal_unless_recycled(pid, start, libc::SIGKILL));
        let status = child.wait().unwrap();
        assert!(status.code().is_none(), "SIGKILL leaves no exit code: {status}");
        assert!(!super::process_alive(pid));
    }

    #[test]
    fn run_bounded_returns_when_a_background_job_keeps_the_pipe_open() {
        let started = std::time::Instant::now();
        let out = super::run_bounded(
            // the background sleep inherits stdout and outlives the command
            std::process::Command::new("/bin/sh").args(["-c", "sleep 8 & printf started"]),
            std::time::Duration::from_secs(20),
            1024,
        )
        .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "hung on the inherited pipe");
        assert_eq!(out.code, Some(0));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "started");
    }
}

