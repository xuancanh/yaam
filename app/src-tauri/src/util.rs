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

// ── bounded subprocess execution ────────────────────────────────────────────

/// Generous wall-clock limit for git-family subprocesses (git.rs, worktree.rs):
/// lock contention or a hung fsmonitor must surface as an error the frontend
/// can show, not hang the IPC call forever.
pub(crate) const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Tail cap per output pipe for git-family subprocesses, consistent with
/// exec_command's. A giant diff keeps its tail with a truncation marker
/// instead of marshalling unbounded bytes across the bridge.
pub(crate) const GIT_OUTPUT_CAP: usize = 40_000;

/// Drain a pipe completely while retaining only its bounded tail. Continuing
/// to drain is essential: stopping at the cap would block the child on a full
/// OS pipe and turn truncation into a deadlock.
pub(crate) fn read_capped_tail<R: Read>(reader: &mut R, cap: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(cap);
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        kept.extend_from_slice(&chunk[..n]);
        if kept.len() > cap {
            let excess = kept.len() - cap;
            kept.drain(..excess);
            truncated = true;
        }
    }
    (kept, truncated)
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

/// Run `command` to completion under a wall-clock `timeout`. Stdout and stderr
/// are drained on their own threads (a child that writes more than the pipe
/// buffer would otherwise block forever before exiting) while retaining only a
/// capped tail of each. On timeout the whole process group is SIGKILLed and an
/// Err returned, so a wedged child can never hang its caller.
pub(crate) fn run_bounded(
    command: &mut Command,
    timeout: std::time::Duration,
    cap: usize,
) -> Result<BoundedOutput, String> {
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
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        stdout_pipe
            .as_mut()
            .map(|p| read_capped_tail(p, cap))
            .unwrap_or_default()
    });
    let err_thread = std::thread::spawn(move || {
        stderr_pipe
            .as_mut()
            .map(|p| read_capped_tail(p, cap))
            .unwrap_or_default()
    });
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
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
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err(format!("command timed out after {}s", timeout.as_secs()));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    let (stdout, stdout_truncated) = out_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = err_thread.join().unwrap_or_default();
    Ok(BoundedOutput {
        code: status.code(),
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
    })
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
}
