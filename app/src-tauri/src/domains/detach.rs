//! Detachable sessions: the PTY lives in a separate daemonized host process
//! (spawned with setsid), so the session survives the app. The app talks to
//! it through a per-session unix socket via a tiny attach client that runs
//! INSIDE a normal app PTY session — all existing terminal machinery (xterm,
//! taps, monitors, resize, exit events) works unchanged. Killing the attach
//! client merely detaches; `detached_kill` ends the real session.
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DetachedSpec {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    /// Shell selected in YAAM for loading the user's command environment.
    #[serde(default)]
    pub command_shell: Option<String>,
    pub rows: u16,
    pub cols: u16,
    #[serde(default)]
    pub pid: Option<i32>,
    /// Written by the host before it exits so the attach wrapper can report the
    /// real command's status through the normal `session-exit` event.
    #[serde(default)]
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct DetachedInfo {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub running: bool,
    /// Rebuilt with the currently-running app binary so upgrades/moves do not
    /// leave persisted attach commands pointing at an obsolete executable.
    pub attach: String,
}

fn dir() -> PathBuf {
    let d = PathBuf::from(crate::util::expand_tilde("~/.yaam/detached"));
    let _ = std::fs::create_dir_all(&d);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
    d
}
fn spec_path(id: &str) -> PathBuf { dir().join(format!("{id}.json")) }
fn sock_path(id: &str) -> PathBuf { dir().join(format!("{id}.sock")) }

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn write_spec(path: &std::path::Path, spec: &DetachedSpec) -> Result<(), String> {
    use std::fs::OpenOptions;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(serde_json::to_string(spec).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn spec_for_sock(sock: &std::path::Path) -> PathBuf { sock.with_extension("json") }

/// Consume a completed host's real exit status. If the socket merely broke
/// while the host is still alive there is no status yet, so the caller keeps
/// its historical attach-client behavior instead.
fn take_exit_code(sock: &std::path::Path) -> Option<i32> {
    let path = spec_for_sock(sock);
    let spec = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<DetachedSpec>(&s).ok())?;
    let code = spec.exit_code?;
    let _ = std::fs::remove_file(path);
    Some(code)
}

// ── wire protocol (client → host): [type u8][len u32 le][payload] ──────────
const F_DATA: u8 = 0;
const F_RESIZE: u8 = 1;
const F_KILL: u8 = 2;

pub(crate) fn write_frame(w: &mut impl Write, t: u8, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&[t])?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

pub(crate) fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 5];
    r.read_exact(&mut h)?;
    let len = u32::from_le_bytes([h[1], h[2], h[3], h[4]]) as usize;
    if len > 1_000_000 {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut p = vec![0u8; len];
    r.read_exact(&mut p)?;
    Ok((h[0], p))
}

// ── host process: owns the PTY, survives the app ────────────────────────────

/// Core host loop, factored for tests (the `--yaam-host` entry daemonizes
/// around it). Serves one attach client at a time; the ring replays recent
/// output on connect.
pub fn run_host(spec: &DetachedSpec, sock: &PathBuf) -> i32 {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let _ = std::fs::remove_file(sock);
    let listener = match UnixListener::bind(sock) { Ok(l) => l, Err(_) => return 1 };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600)).is_err() {
            return 1;
        }
    }
    let pair = match native_pty_system().openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 }) {
        Ok(p) => p,
        Err(_) => return 1,
    };
    let (executable, args, shell_env) = match crate::domains::session::command_launch_spec(
        &spec.command,
        spec.command_shell.as_deref(),
    ) {
        Ok(spec) => spec,
        Err(_) => return 1,
    };
    let mut cb = CommandBuilder::new(executable);
    cb.args(args);
    cb.env("TERM", "xterm-256color");
    if let Some(shell) = shell_env { cb.env("SHELL", shell); }
    if let Some(cwd) = spec.cwd.as_ref().filter(|c| !c.is_empty()) {
        cb.cwd(PathBuf::from(crate::util::expand_tilde(cwd)));
    }
    let mut child = match pair.slave.spawn_command(cb) { Ok(c) => c, Err(_) => return 1 };
    let mut reader = pair.master.try_clone_reader().expect("pty reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("pty writer")));
    let master = Arc::new(Mutex::new(pair.master));
    let ring: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let client: Arc<Mutex<Option<UnixStream>>> = Arc::new(Mutex::new(None));
    let mut killer = child.clone_killer();
    let mut frame_killer = child.clone_killer();

    // PTY → ring + connected client
    let (ring2, client2) = (ring.clone(), client.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 { break }
            let mut r = ring2.lock().unwrap();
            r.extend_from_slice(&buf[..n]);
            let excess = r.len().saturating_sub(200_000);
            if excess > 0 { r.drain(..excess); }
            drop(r);
            let mut c = client2.lock().unwrap();
            if let Some(s) = c.as_mut() {
                if s.write_all(&buf[..n]).is_err() { *c = None; } // client left — keep running
            }
        }
    });

    // accept loop: replay ring, then process control frames
    let (ring3, client3, writer3, master3) = (ring, client, writer, master);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut out = match stream.try_clone() { Ok(s) => s, Err(_) => continue };
            let backlog = ring3.lock().unwrap().clone();
            if out.write_all(&backlog).is_err() { continue }
            *client3.lock().unwrap() = Some(out);
            let mut inp = stream;
            loop {
                match read_frame(&mut inp) {
                    Ok((F_DATA, p)) => { let _ = writer3.lock().unwrap().write_all(&p); let _ = writer3.lock().unwrap().flush(); }
                    Ok((F_RESIZE, p)) if p.len() >= 4 => {
                        let rows = u16::from_le_bytes([p[0], p[1]]);
                        let cols = u16::from_le_bytes([p[2], p[3]]);
                        let _ = master3.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                    }
                    Ok((F_KILL, _)) => { let _ = frame_killer.kill(); } // child.wait() unblocks → clean exit
                    Ok(_) => {}
                    Err(_) => break, // client disconnected — stay alive, await the next
                }
            }
        }
    });

    let code = child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(0);
    let _ = killer.kill();
    // Publish the real child's exit code before closing the socket/process. The
    // attach wrapper consumes this file after observing EOF and returns the same
    // code to SessionManager's ordinary child reaper. Only write while the spec
    // on disk is still ours — after a stop + quick relaunch it belongs to the
    // replacement host, and a late write here would clobber its command.
    let ours = std::fs::read_to_string(spec_for_sock(sock))
        .ok()
        .and_then(|s| serde_json::from_str::<DetachedSpec>(&s).ok())
        .map_or(true, |d| d.pid == spec.pid);
    if ours {
        let mut completed = spec.clone();
        completed.exit_code = Some(code);
        let _ = write_spec(&spec_for_sock(sock), &completed);
        let _ = std::fs::remove_file(sock); // a replacement host may own this path now
    }
    code
}

/// Attach-client loop (runs inside a normal app PTY session): raw stdin →
/// data frames, socket bytes → stdout, SIGWINCH → resize frames.
pub fn run_attach(sock: &PathBuf) -> i32 {
    let Ok(stream) = UnixStream::connect(sock) else {
        if let Some(code) = take_exit_code(sock) {
            return code;
        }
        eprintln!("yaam: detached session is gone");
        return 1;
    };
    let mut sock_in = stream.try_clone().expect("socket clone");
    let sock_out = Arc::new(Mutex::new(stream));

    // Raw mode on our own terminal (the app-side PTY slave). Without this the
    // kernel line discipline echoes every byte xterm sends (arrow keys, DA
    // responses, focus events show up as literal ^[[A garbage on screen) and
    // line-buffers input, so the real session only sees keys after Enter. The
    // host PTY is the one true line discipline; ours must be a dumb pipe.
    let cooked = unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) == 0 {
            let orig = t;
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(0, libc::TCSANOW, &t);
            Some(orig)
        } else {
            None
        }
    };

    // propagate our PTY size (the app resizes it normally) to the host PTY
    let send_size = {
        let sock_out = sock_out.clone();
        move || {
            let mut ws = libc::winsize { ws_row: 0, ws_col: 0, ws_xpixel: 0, ws_ypixel: 0 };
            if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_row > 0 {
                let mut p = Vec::with_capacity(4);
                p.extend_from_slice(&ws.ws_row.to_le_bytes());
                p.extend_from_slice(&ws.ws_col.to_le_bytes());
                let _ = write_frame(&mut *sock_out.lock().unwrap(), F_RESIZE, &p);
            }
        }
    };
    send_size();
    // SIGWINCH → resize (async-signal-safety shortcut: flag + poll thread)
    static WINCH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    unsafe {
        libc::signal(libc::SIGWINCH, handle_winch as *const () as usize);
    }
    extern "C" fn handle_winch(_: i32) { WINCH.store(true, std::sync::atomic::Ordering::Relaxed); }
    {
        let send_size = send_size.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if WINCH.swap(false, std::sync::atomic::Ordering::Relaxed) { send_size(); }
        });
    }

    // stdin → host
    let sock_out2 = sock_out.clone();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        while let Ok(n) = stdin.read(&mut buf) {
            if n == 0 { break }
            if write_frame(&mut *sock_out2.lock().unwrap(), F_DATA, &buf[..n]).is_err() { break }
        }
    });

    // host → stdout (ends when the host/session exits)
    let mut stdout = std::io::stdout();
    let mut buf = [0u8; 8192];
    while let Ok(n) = sock_in.read(&mut buf) {
        if n == 0 { break }
        if stdout.write_all(&buf[..n]).is_err() { break }
        let _ = stdout.flush();
    }
    if let Some(orig) = cooked {
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &orig) };
    }
    take_exit_code(sock).unwrap_or(0)
}

/// Binary entry dispatch: returns true when this invocation was a detached
/// host/attach process (the caller must NOT start Tauri then).
pub fn detach_entry() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--yaam-host") {
        let id = args.get(i + 1).cloned().unwrap_or_default();
        if !valid_id(&id) { std::process::exit(1); }
        let spec: DetachedSpec = std::fs::read_to_string(spec_path(&id))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| std::process::exit(1));
        // record our pid for kill/monitor
        let mut spec2 = spec.clone();
        spec2.pid = Some(std::process::id() as i32);
        let _ = write_spec(&spec_path(&id), &spec2);
        std::process::exit(run_host(&spec2, &sock_path(&id)));
    }
    if let Some(i) = args.iter().position(|a| a == "--yaam-attach") {
        let sock = PathBuf::from(args.get(i + 1).cloned().unwrap_or_default());
        std::process::exit(run_attach(&sock));
    }
    false
}

// ── tauri commands ──────────────────────────────────────────────────────────

/// Ensure a detached host exists and return the attach command line the app
/// should run as a normal PTY session (also the session's resume command).
/// Idempotent: a live host is reattached as-is; a dead/stopped one is
/// relaunched fresh. An empty `command` reuses the stored spec (legacy agents
/// that only persisted the attach wrapper).
#[tauri::command]
pub fn detached_spawn(id: String, command: String, cwd: Option<String>, command_shell: Option<String>, rows: Option<u16>, cols: Option<u16>) -> Result<String, String> {
    if !valid_id(&id) { return Err("invalid detached session id".to_string()); }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sock = sock_path(&id);
    let attach = format!("\"{}\" --yaam-attach \"{}\"", exe.display(), sock.display());
    if UnixStream::connect(&sock).is_ok() {
        return Ok(attach); // still running — just reattach
    }
    let _ = std::fs::remove_file(&sock); // stale socket from a dead host
    let spec = if command.trim().is_empty() {
        let mut old = std::fs::read_to_string(spec_path(&id))
            .ok()
            .and_then(|s| serde_json::from_str::<DetachedSpec>(&s).ok())
            .ok_or("detached session ended and its command was not recorded — start a new session")?;
        old.pid = None;
        old.exit_code = None;
        old
    } else {
        DetachedSpec { id: id.clone(), command, cwd, command_shell, rows: rows.unwrap_or(24), cols: cols.unwrap_or(80), pid: None, exit_code: None }
    };
    write_spec(&spec_path(&id), &spec)?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--yaam-host", &id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid(); // own session — detached from the app's lifecycle
                Ok(())
            });
        }
    }
    cmd.spawn().map_err(|e| format!("could not start session host: {e}"))?;
    // wait for the socket so the attach client doesn't race the host
    for _ in 0..50 {
        if UnixStream::connect(&sock).is_ok() { break }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(attach)
}

/// Detached sessions on disk, with a liveness probe per socket.
#[tauri::command]
pub fn detached_list() -> Vec<DetachedInfo> {
    let mut out = Vec::new();
    let exe = std::env::current_exe().ok();
    if let Ok(rd) = std::fs::read_dir(dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") { continue }
            if let Some(spec) = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<DetachedSpec>(&s).ok()) {
                if !valid_id(&spec.id) { continue; }
                let running = UnixStream::connect(sock_path(&spec.id)).is_ok();
                if !running {
                    let _ = std::fs::remove_file(&p); // stale leftovers
                    continue;
                }
                let attach = exe.as_ref()
                    .map(|exe| format!("\"{}\" --yaam-attach \"{}\"", exe.display(), sock_path(&spec.id).display()))
                    .unwrap_or_default();
                out.push(DetachedInfo { id: spec.id, command: spec.command, cwd: spec.cwd, running, attach });
            }
        }
    }
    out
}

/// End a detached session for real (SIGTERM its host's process group).
#[tauri::command]
pub fn detached_kill(id: String) -> Result<(), String> {
    if !valid_id(&id) { return Err("invalid detached session id".to_string()); }
    if let Some(spec) = std::fs::read_to_string(spec_path(&id)).ok().and_then(|s| serde_json::from_str::<DetachedSpec>(&s).ok()) {
        if let Some(pid) = spec.pid {
            unsafe { libc::kill(-pid, libc::SIGTERM) };
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    let _ = std::fs::remove_file(sock_path(&id));
    let _ = std::fs::remove_file(spec_path(&id));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, F_RESIZE, &[40, 0, 120, 0]).unwrap();
        write_frame(&mut buf, F_DATA, b"ls -la\n").unwrap();
        let mut r = std::io::Cursor::new(buf);
        let (t1, p1) = read_frame(&mut r).unwrap();
        assert_eq!((t1, p1.as_slice()), (F_RESIZE, &[40u8, 0, 120, 0][..]));
        let (t2, p2) = read_frame(&mut r).unwrap();
        assert_eq!((t2, p2.as_slice()), (F_DATA, b"ls -la\n".as_slice()));
    }

    #[test]
    fn detached_ids_cannot_escape_the_private_state_directory() {
        assert!(valid_id("agent-abc_123"));
        assert!(!valid_id(""));
        assert!(!valid_id("../../outside"));
        assert!(!valid_id("nested/session"));
        assert!(detached_kill("../../outside".into()).is_err());
    }

    #[test]
    fn dying_host_does_not_clobber_a_replacement_spec() {
        let id = format!("t-clobber-{}", std::process::id());
        let sock = std::env::temp_dir().join(format!("yaam-detach-{id}.sock"));
        let spec = DetachedSpec { id: id.clone(), command: "true".into(), cwd: None, command_shell: None, rows: 24, cols: 80, pid: Some(4242), exit_code: None };
        // stop + quick relaunch: a replacement host's fresh spec (pid not yet
        // recorded) is already on disk when the old host finally exits
        let replacement = DetachedSpec { pid: None, exit_code: None, ..spec.clone() };
        std::fs::write(spec_for_sock(&sock), serde_json::to_string(&replacement).unwrap()).unwrap();
        run_host(&spec, &sock);
        let on_disk: DetachedSpec = serde_json::from_str(&std::fs::read_to_string(spec_for_sock(&sock)).unwrap()).unwrap();
        assert_eq!(on_disk.exit_code, None, "old host must not write its exit code over the replacement's spec");
        assert_eq!(on_disk.pid, None);
        let _ = std::fs::remove_file(spec_for_sock(&sock));
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn host_serves_backlog_and_stdin_end_to_end() {
        let id = format!("t-{}", std::process::id());
        let sock = std::env::temp_dir().join(format!("yaam-detach-{id}.sock"));
        let spec = DetachedSpec { id, command: "printf ready; cat".into(), cwd: None, command_shell: None, rows: 24, cols: 80, pid: None, exit_code: None };
        let s2 = spec.clone();
        let sockc = sock.clone();
        std::thread::spawn(move || { run_host(&s2, &sockc); });
        // wait for the socket, connect, expect the ring backlog
        let mut stream = None;
        for _ in 0..50 {
            if let Ok(s) = UnixStream::connect(&sock) { stream = Some(s); break }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let mut stream = stream.expect("host socket");
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut got = Vec::new();
        let mut buf = [0u8; 256];
        while !String::from_utf8_lossy(&got).contains("ready") {
            let n = stream.read(&mut buf).expect("backlog");
            got.extend_from_slice(&buf[..n]);
        }
        // stdin frame → cat echoes it back through the pty
        write_frame(&mut stream, F_DATA, b"hello-detach\r").unwrap();
        let mut echoed = String::new();
        while !echoed.contains("hello-detach") {
            let n = stream.read(&mut buf).expect("echo");
            echoed.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        // a SECOND client reconnects and gets the ring replay (app restart)
        drop(stream);
        let mut s2 = UnixStream::connect(&sock).expect("reconnect");
        s2.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut replay = Vec::new();
        while !String::from_utf8_lossy(&replay).contains("ready") {
            let n = s2.read(&mut buf).expect("replay");
            replay.extend_from_slice(&buf[..n]);
        }
        let _ = write_frame(&mut s2, F_KILL, &[]);
    }

    #[test]
    fn host_publishes_the_real_exit_code_for_attach() {
        let id = format!("exit-{}", std::process::id());
        let sock = std::env::temp_dir().join(format!("yaam-detach-{id}.sock"));
        let spec = DetachedSpec {
            id,
            command: "exit 23".into(),
            cwd: None,
            command_shell: None,
            rows: 24,
            cols: 80,
            pid: None,
            exit_code: None,
        };
        std::fs::write(spec_for_sock(&sock), serde_json::to_string(&spec).unwrap()).unwrap();
        assert_eq!(run_host(&spec, &sock), 23);
        assert_eq!(take_exit_code(&sock), Some(23));
        assert!(!spec_for_sock(&sock).exists(), "reading the status consumes the completion record");
    }
}
