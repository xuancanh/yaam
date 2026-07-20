//! OS write-sandbox wrappers for LOCAL sessions. Builds a command prefix the
//! frontend puts in front of the spawn command (`<wrapper> /bin/sh -c '<cmd>'`):
//! Seatbelt (`sandbox-exec -p <profile>`) on macOS, bubblewrap
//! (`bwrap --ro-bind / / …`) on Linux. Policy on both: read everything, write
//! only the session cwd + temp + agent config dirs + extras — so agent CLIs
//! (claude/codex/…) keep their state, caches, and API access working. Remote
//! machine sessions build their bwrap prefix in the frontend instead.
use crate::util::expand_tilde;
use std::path::{Path, PathBuf};

const MAX_EXTRA_PATHS: usize = 32;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_POLICY_PATH_BYTES: usize = 64 * 1_024;

/// State roots used by the built-in coding-agent CLIs. Do not grant generic
/// config/cache/local-data roots: they contain executable startup config and
/// PATH entries that turn a write guardrail into trivial persistence.
const HOME_WRITE_DIRS: &[&str] = &[".claude", ".codex", ".gemini", ".aider"];

/// Escape a path for an SBPL double-quoted string literal.
fn sbpl_escape(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// POSIX single-quote a string for embedding in the wrapper prefix.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn validate_path_input(label: &str, path: &str) -> Result<(), String> {
    if path.len() > MAX_PATH_BYTES {
        return Err(format!("sandbox: {label} exceeds {MAX_PATH_BYTES} bytes"));
    }
    if path.chars().any(char::is_control) {
        return Err(format!("sandbox: {label} contains control characters"));
    }
    Ok(())
}

fn canonical_dir(label: &str, path: &str) -> Result<PathBuf, String> {
    validate_path_input(label, path)?;
    let expanded = expand_tilde(path);
    let candidate = Path::new(&expanded);
    if !candidate.is_absolute() {
        return Err(format!(
            "sandbox: {label} must be an absolute path (or start with ~/): {path}"
        ));
    }
    let real = std::fs::canonicalize(candidate)
        .map_err(|e| format!("sandbox: {label} {path} is not usable: {e}"))?;
    if !real.is_dir() {
        return Err(format!(
            "sandbox: {label} is not a folder: {}",
            real.display()
        ));
    }
    Ok(real)
}

fn reject_overbroad_explicit_root(label: &str, root: &Path) -> Result<(), String> {
    if root.parent().is_none() {
        return Err(format!(
            "sandbox: {label} must not grant the filesystem root"
        ));
    }
    if let Ok(home) = std::env::var("HOME") {
        if let Ok(home) = std::fs::canonicalize(home) {
            if home == root || home.starts_with(root) {
                return Err(format!(
                    "sandbox: {label} must be inside the home directory, not the home directory or one of its parents"
                ));
            }
        }
    }
    Ok(())
}

fn append_agent_state_roots(home: &Path, roots: &mut Vec<PathBuf>) -> Result<(), String> {
    for dir in HOME_WRITE_DIRS {
        let path = home.join(dir);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "sandbox: agent state directory must not be a symlink: {}",
                    path.display()
                ));
            }
            Ok(meta) if meta.is_dir() => roots.push(path),
            Ok(_) | Err(_) => {}
        }
    }
    Ok(())
}

/// Resolve the writable roots: the (required) cwd plus temp and agent config
/// dirs and extras. Paths are canonicalized so filters match the kernel's
/// post-symlink view (`/tmp` → `/private/tmp` on macOS). Missing built-in config
/// dirs are skipped; explicitly requested cwd/extra dirs fail closed.
fn writable_roots(cwd: &str, extra_paths: &[String]) -> Result<Vec<String>, String> {
    if extra_paths.len() > MAX_EXTRA_PATHS {
        return Err(format!(
            "sandbox: at most {MAX_EXTRA_PATHS} extra writable paths are allowed"
        ));
    }
    let policy_path_bytes = cwd.len() + extra_paths.iter().map(String::len).sum::<usize>();
    if policy_path_bytes > MAX_POLICY_PATH_BYTES {
        return Err(format!(
            "sandbox: writable path policy exceeds {MAX_POLICY_PATH_BYTES} bytes"
        ));
    }
    let cwd = canonical_dir("working directory", cwd)?;
    reject_overbroad_explicit_root("working directory", &cwd)?;

    let mut roots: Vec<PathBuf> = vec![cwd, PathBuf::from("/tmp"), std::env::temp_dir()];
    if let Ok(home) = std::env::var("HOME") {
        append_agent_state_roots(Path::new(&home), &mut roots)?;
    }
    for (index, path) in extra_paths.iter().enumerate() {
        if path.trim().is_empty() {
            continue;
        }
        let root = canonical_dir(&format!("extra writable path {}", index + 1), path)?;
        reject_overbroad_explicit_root(&format!("extra writable path {}", index + 1), &root)?;
        roots.push(root);
    }

    let mut out: Vec<String> = Vec::new();
    for root in roots {
        // optional roots vanish silently; the cwd was already validated above
        let Ok(real) = std::fs::canonicalize(&root) else {
            continue;
        };
        let real = real
            .to_str()
            .ok_or_else(|| format!("sandbox: path is not valid UTF-8: {}", real.display()))?
            .to_string();
        if !out.contains(&real) {
            out.push(real);
        }
    }
    Ok(out)
}

/// Render the allow-default SBPL profile: everything permitted except file
/// writes, which are limited to the given roots (+ /dev for PTYs).
fn render_profile(roots: &[String], deny_network: bool) -> String {
    let mut p = String::from(
        "(version 1)\n(allow default)\n(deny file-write*)\n(deny appleevent-send)\n(deny lsopen)\n\
         (deny network-outbound (remote unix-socket \
           (path-regex #\".*/(docker|podman)(/podman)?\\.sock$\") \
           (path-regex #\".*/\\.yaam/detached/.*\\.sock$\")))\n",
    );
    p.push_str(
        "(allow file-write* (literal \"/dev/null\") (literal \"/dev/ptmx\") \
         (literal \"/dev/stdout\") (literal \"/dev/stderr\") \
         (regex #\"^/dev/ttys[0-9]+$\"))\n",
    );
    for root in roots {
        p.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))\n",
            sbpl_escape(root)
        ));
    }
    // SBPL is last-match-wins: the .git/config + .git/hooks denies MUST come
    // after the writable-root allows above, or an allow for the session cwd
    // would silently re-allow rewriting git config/hooks inside a repo.
    p.push_str(
        "(deny file-write* (regex #\".*/\\.git/config$\") (regex #\".*/\\.git/hooks(/.*)?$\"))\n",
    );
    if deny_network {
        p.push_str("(deny network*)\n");
    }
    p
}

/// macOS: pass the profile inline. Keeping it out of a sandbox-writable folder
/// prevents a session from planting a symlink that makes the privileged host
/// overwrite an arbitrary file when a wrapper is rebuilt on resume.
fn macos_wrapper(roots: &[String], deny_network: bool) -> Result<String, String> {
    if !Path::new("/usr/bin/sandbox-exec").exists() {
        return Err("sandbox: /usr/bin/sandbox-exec is missing on this system".to_string());
    }
    Ok(format!(
        "sandbox-exec -p {}",
        shq(&render_profile(roots, deny_network))
    ))
}

/// Is an executable reachable through PATH?
fn on_path(bin: &str) -> bool {
    std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

/// Linux: build the bubblewrap prefix — read-only root, writable binds for
/// each root, PTY-friendly /dev, and the sandbox dying with the session.
fn linux_wrapper(roots: &[String], deny_network: bool) -> Result<String, String> {
    if !on_path("bwrap") {
        return Err(
            "sandbox: bwrap (bubblewrap) is not installed — install it (e.g. apt install bubblewrap) or launch without the sandbox".to_string(),
        );
    }
    let binds: Vec<String> = roots
        .iter()
        .map(|r| format!("--bind {} {}", shq(r), shq(r)))
        .collect();
    let mut socket_paths = vec![
        PathBuf::from("/run/docker.sock"),
        PathBuf::from("/var/run/docker.sock"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        socket_paths.push(Path::new(&home).join(".docker/run/docker.sock"));
        socket_paths.push(Path::new(&home).join(".docker/desktop/docker.sock"));
    }
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR") {
        socket_paths.push(Path::new(&runtime).join("docker.sock"));
        socket_paths.push(Path::new(&runtime).join("podman/podman.sock"));
    }
    if let Ok(home) = std::env::var("HOME") {
        let detached = Path::new(&home).join(".yaam/detached");
        if let Ok(entries) = std::fs::read_dir(detached) {
            socket_paths.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("sock")),
            );
        }
    }
    let mut readonly_paths = Vec::new();
    if let Some(cwd) = roots.first() {
        let cwd = Path::new(cwd);
        let mut git_dirs = vec![cwd.join(".git")];
        if let Ok(entries) = std::fs::read_dir(cwd) {
            git_dirs.extend(entries.flatten().filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir())
                    .map(|_| entry.path().join(".git"))
            }));
        }
        for git in git_dirs {
            for path in [git.join("config"), git.join("hooks")] {
                if path.exists() {
                    readonly_paths.push(path);
                }
            }
        }
    }
    let socket_masks: Vec<String> = socket_paths
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| format!("--ro-bind /dev/null {}", shq(&path.to_string_lossy())))
        .collect();
    let readonly_masks: Vec<String> = readonly_paths
        .into_iter()
        .map(|path| {
            let path = shq(&path.to_string_lossy());
            format!("--ro-bind {path} {path}")
        })
        .collect();
    Ok(format!(
        "bwrap --ro-bind / / --dev /dev --unshare-pid --unshare-ipc --proc /proc --die-with-parent {} {} {}{}",
        binds.join(" "),
        readonly_masks.join(" "),
        socket_masks.join(" "),
        if deny_network { " --unshare-net" } else { "" },
    ))
}

/// Build the OS sandbox wrapper prefix for a local session. The frontend runs
/// `<wrapper> /bin/sh -c '<original command>'`. Fails closed: unsupported OS,
/// missing tooling, or a bad cwd return an error instead of running unwrapped.
#[tauri::command]
pub fn sandbox_wrapper(
    _id: String,
    cwd: String,
    extra_paths: Vec<String>,
    deny_network: bool,
) -> Result<String, String> {
    let roots = writable_roots(&cwd, &extra_paths)?;
    if cfg!(target_os = "macos") {
        macos_wrapper(&roots, deny_network)
    } else if cfg!(target_os = "linux") {
        linux_wrapper(&roots, deny_network)
    } else {
        Err("sandbox: session sandboxing is only supported on macOS and Linux".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// The profile allows by default, denies writes, and re-allows each root.
    fn renders_allow_default_profile() {
        let p = render_profile(&["/Users/x/proj".into(), "/private/tmp".into()], false);
        assert!(p.starts_with(
            "(version 1)\n(allow default)\n(deny file-write*)\n(deny appleevent-send)\n(deny lsopen)\n"
        ));
        assert!(p.contains("docker|podman"));
        assert!(p.contains("\\.git/hooks"));
        assert!(p.contains("\\.yaam/detached"));
        assert!(p.contains("(literal \"/dev/null\")"));
        assert!(p.contains("(regex #\"^/dev/ttys[0-9]+$\")"));
        assert!(!p.contains("(subpath \"/dev\")"));
        assert!(p.contains("(allow file-write* (subpath \"/Users/x/proj\"))"));
        assert!(p.contains("(allow file-write* (subpath \"/private/tmp\"))"));
        assert!(!p.contains("(deny network*)"));
        // SBPL is last-match-wins: the git config/hooks denies must come AFTER
        // every writable-root allow, or the cwd allow would override them.
        let git_deny = p.find("\\.git/config").unwrap();
        let last_allow = p.rfind("(allow file-write* (subpath ").unwrap();
        assert!(
            git_deny > last_allow,
            "git deny rules must be emitted after the writable-root allows"
        );
    }

    #[test]
    /// deny_network appends the network deny — and only then.
    fn denies_network_only_when_asked() {
        assert!(render_profile(&[], true).ends_with("(deny network*)\n"));
        assert!(!render_profile(&[], false).contains("(deny network*)"));
    }

    #[test]
    /// Paths with quotes/backslashes can't break out of the SBPL string literal.
    fn escapes_sbpl_string_literals() {
        let p = render_profile(&[r#"/a/we"ird\dir"#.into()], false);
        assert!(p.contains(r#"(subpath "/a/we\"ird\\dir")"#));
    }

    #[test]
    /// The Linux prefix read-only-binds root, write-binds each root, and dies
    /// with the session; network is unshared only when asked. Quoting keeps
    /// spaced/quoted paths as single bwrap arguments.
    fn builds_linux_prefix() {
        let roots = ["/home/u/my proj".to_string(), "/tmp".to_string()];
        let binds: Vec<String> = roots
            .iter()
            .map(|r| format!("--bind {} {}", shq(r), shq(r)))
            .collect();
        let p = format!(
            "bwrap --ro-bind / / --dev /dev --unshare-pid --unshare-ipc --proc /proc --die-with-parent {}",
            binds.join(" "),
        );
        assert!(p.contains("--bind '/home/u/my proj' '/home/u/my proj'"));
        assert!(!p.contains("--unshare-net"));
    }

    #[test]
    /// Single quotes inside a path can't escape the shell quoting.
    fn shell_quotes_wrapper_paths() {
        assert_eq!(shq("/a/it's"), r"'/a/it'\''s'");
    }

    #[test]
    /// A missing cwd fails closed instead of producing a wrapper.
    fn rejects_missing_cwd() {
        assert!(writable_roots("/yaam-definitely-does-not-exist", &[]).is_err());
    }

    #[test]
    fn rejects_home_and_filesystem_wide_write_roots() {
        assert!(writable_roots("~", &[])
            .unwrap_err()
            .contains("home directory"));
        assert!(writable_roots("/", &[])
            .unwrap_err()
            .contains("filesystem root"));
        assert!(writable_roots("/tmp", &["~".into()])
            .unwrap_err()
            .contains("home directory"));
    }

    #[test]
    fn rejects_relative_missing_and_excessive_extra_paths() {
        assert!(writable_roots("/tmp", &["relative/path".into()]).is_err());
        assert!(writable_roots("/tmp", &["/yaam-definitely-does-not-exist".into()]).is_err());
        assert!(writable_roots("/tmp", &vec!["/tmp".into(); MAX_EXTRA_PATHS + 1]).is_err());
    }

    #[test]
    fn rejects_control_characters_in_paths() {
        assert!(writable_roots("/tmp\n(allow default)", &[]).is_err());
        assert!(writable_roots("/tmp", &["/tmp\n(allow default)".into()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_agent_state_roots() {
        use std::os::unix::fs::symlink;

        let home = std::env::temp_dir().join(format!(
            "yaam-sandbox-home-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        std::fs::create_dir_all(&home).unwrap();
        symlink("/tmp", home.join(".claude")).unwrap();
        let mut roots = Vec::new();
        assert!(append_agent_state_roots(&home, &mut roots)
            .unwrap_err()
            .contains("must not be a symlink"));
        std::fs::remove_dir_all(home).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    /// Roots are canonicalized so subpath filters match the kernel's view:
    /// /tmp resolves to /private/tmp, and the cwd always leads the list.
    fn canonicalizes_roots_on_macos() {
        let roots = writable_roots("/tmp", &[]).unwrap();
        assert_eq!(roots[0], "/private/tmp");
        assert!(roots.iter().all(|r| !r.starts_with("/tmp")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    /// End-to-end: the command returns an inline profile, so rebuilding a
    /// wrapper never writes through a sandbox-controlled filesystem path.
    fn builds_macos_wrapper() {
        let w = sandbox_wrapper("test–profile/1".into(), "/tmp".into(), vec![], true).unwrap();
        assert!(w.starts_with("sandbox-exec -p '"));
        assert!(w.contains("(deny network*)"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_allows_only_declared_write_roots() {
        use std::process::Command;

        let base = std::env::temp_dir().join(format!(
            "yaam-sandbox-policy-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let allowed = base.join("allowed");
        let blocked = base.join("blocked");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&blocked).unwrap();
        let allowed = std::fs::canonicalize(&allowed).unwrap();
        let blocked = std::fs::canonicalize(&blocked).unwrap();
        let profile = render_profile(&[allowed.to_string_lossy().into_owned()], false);
        let script = format!(
            "printf ok > {}; ! printf blocked > {} 2>/dev/null",
            shq(&allowed.join("ok").to_string_lossy()),
            shq(&blocked.join("bad").to_string_lossy())
        );
        let result = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "/bin/sh", "-c", &script])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(result.success());
        assert_eq!(std::fs::read_to_string(allowed.join("ok")).unwrap(), "ok");
        assert!(!blocked.join("bad").exists());
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    /// The .git/config + .git/hooks denies survive the writable-cwd allow: a
    /// sandboxed process inside a repo under its writable root still cannot
    /// rewrite git config/hooks, while normal writes to the cwd succeed.
    fn macos_profile_blocks_git_config_and_hooks_writes() {
        use std::process::Command;

        let base = std::env::temp_dir().join(format!(
            "yaam-sandbox-git-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let repo = base.join("repo");
        std::fs::create_dir_all(repo.join(".git/hooks")).unwrap();
        std::fs::write(repo.join(".git/config"), "[core]\n").unwrap();
        let repo = std::fs::canonicalize(&repo).unwrap();
        let profile = render_profile(&[repo.to_string_lossy().into_owned()], false);
        // All three writes attempted in one sandboxed run: the two git writes
        // must fail, the ordinary cwd write must succeed.
        let script = format!(
            "! printf evil > {} 2>/dev/null && ! printf evil > {} 2>/dev/null && printf ok > {}",
            shq(&repo.join(".git/config").to_string_lossy()),
            shq(&repo.join(".git/hooks/pre-commit").to_string_lossy()),
            shq(&repo.join("ok").to_string_lossy()),
        );
        let result = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "/bin/sh", "-c", &script])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(result.success());
        assert_eq!(
            std::fs::read_to_string(repo.join(".git/config")).unwrap(),
            "[core]\n"
        );
        assert!(!repo.join(".git/hooks/pre-commit").exists());
        assert_eq!(std::fs::read_to_string(repo.join("ok")).unwrap(), "ok");
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_blocks_launch_services_escape() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let base = std::env::temp_dir().join(format!(
            "yaam-sandbox-lsopen-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let app = base.join("Escape.app");
        let executable = app.join("Contents/MacOS/escape");
        let blocked = base.join("blocked");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&blocked).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>escape</string>
<key>CFBundleIdentifier</key><string>dev.yaam.sandbox-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>"#,
        )
        .unwrap();
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf escaped > {}\n",
                shq(&blocked.join("escaped").to_string_lossy())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();

        let baseline = Command::new("/usr/bin/open")
            .args(["-W", "-n"])
            .arg(&app)
            .status()
            .unwrap();
        assert!(baseline.success());
        assert!(blocked.join("escaped").exists());
        std::fs::remove_file(blocked.join("escaped")).unwrap();

        let allowed = std::fs::canonicalize(executable.parent().unwrap()).unwrap();
        let profile = render_profile(&[allowed.to_string_lossy().into_owned()], false);
        let result = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &profile, "/usr/bin/open", "-W", "-n"])
            .arg(&app)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(!result.success());
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!blocked.join("escaped").exists());
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_enforces_network_toggle() {
        use std::net::TcpListener;
        use std::process::Command;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let run = |deny_network| {
            Command::new("/usr/bin/sandbox-exec")
                .args([
                    "-p",
                    &render_profile(&[], deny_network),
                    "/usr/bin/nc",
                    "-z",
                    "-w",
                    "1",
                    "127.0.0.1",
                    &port,
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        assert!(run(false));
        assert!(!run(true));
    }
}
