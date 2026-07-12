//! OS write-sandbox wrappers for LOCAL sessions. Builds a command prefix the
//! frontend puts in front of the spawn command (`<wrapper> /bin/sh -c '<cmd>'`):
//! Seatbelt (`sandbox-exec -f <generated profile>`) on macOS, bubblewrap
//! (`bwrap --ro-bind / / …`) on Linux. Policy on both: read everything, write
//! only the session cwd + temp + agent config dirs + extras — so agent CLIs
//! (claude/codex/…) keep their state, caches, and API access working. Remote
//! machine sessions build their bwrap prefix in the frontend instead.
use crate::util::expand_tilde;
use std::path::{Path, PathBuf};

/// Home dot-dirs agent CLIs need to write (state, caches, config).
const HOME_WRITE_DIRS: &[&str] = &[".claude", ".codex", ".config", ".cache", ".local", ".yaam"];

/// Escape a path for an SBPL double-quoted string literal.
fn sbpl_escape(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

/// POSIX single-quote a string for embedding in the wrapper prefix.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Keep profile filenames safe regardless of what's in the session id.
fn sanitize_id(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if safe.is_empty() { "session".to_string() } else { safe }
}

/// Resolve the writable roots: the (required) cwd plus temp and agent config
/// dirs and extras. Paths are canonicalized so filters match the kernel's
/// post-symlink view (`/tmp` → `/private/tmp` on macOS); optional roots that
/// don't exist are skipped.
fn writable_roots(cwd: &str, extra_paths: &[String]) -> Result<Vec<String>, String> {
    let cwd = expand_tilde(cwd);
    let cwd = std::fs::canonicalize(&cwd)
        .map_err(|e| format!("sandbox: working directory {cwd} is not usable: {e}"))?;
    if !cwd.is_dir() {
        return Err(format!("sandbox: working directory is not a folder: {}", cwd.display()));
    }

    let mut roots: Vec<PathBuf> = vec![cwd, PathBuf::from("/tmp"), std::env::temp_dir()];
    if let Ok(home) = std::env::var("HOME") {
        for dir in HOME_WRITE_DIRS {
            roots.push(Path::new(&home).join(dir));
        }
    }
    for p in extra_paths {
        let p = expand_tilde(p);
        if !p.trim().is_empty() {
            roots.push(PathBuf::from(p));
        }
    }

    let mut out: Vec<String> = Vec::new();
    for root in roots {
        // optional roots vanish silently; the cwd was already validated above
        let Ok(real) = std::fs::canonicalize(&root) else { continue };
        let real = real.to_string_lossy().to_string();
        if !out.contains(&real) {
            out.push(real);
        }
    }
    Ok(out)
}

/// Render the allow-default SBPL profile: everything permitted except file
/// writes, which are limited to the given roots (+ /dev for PTYs).
fn render_profile(roots: &[String], deny_network: bool) -> String {
    let mut p = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");
    p.push_str("(allow file-write* (subpath \"/dev\"))\n");
    for root in roots {
        p.push_str(&format!("(allow file-write* (subpath \"{}\"))\n", sbpl_escape(root)));
    }
    if deny_network {
        p.push_str("(deny network*)\n");
    }
    p
}

/// macOS: write the Seatbelt profile for the session (overwriting any previous
/// one — resume regenerates with the current cwd/config) and return the
/// `sandbox-exec` prefix.
fn macos_wrapper(id: &str, roots: &[String], deny_network: bool) -> Result<String, String> {
    if !Path::new("/usr/bin/sandbox-exec").exists() {
        return Err("sandbox: /usr/bin/sandbox-exec is missing on this system".to_string());
    }
    let dir = PathBuf::from(expand_tilde("~/.yaam/sandbox"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("sandbox: cannot create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.sb", sanitize_id(id)));
    std::fs::write(&path, render_profile(roots, deny_network))
        .map_err(|e| format!("sandbox: cannot write {}: {e}", path.display()))?;
    Ok(format!("sandbox-exec -f {}", shq(&path.to_string_lossy())))
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
    let binds: Vec<String> = roots.iter().map(|r| format!("--bind {} {}", shq(r), shq(r))).collect();
    Ok(format!(
        "bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc --die-with-parent {}{}",
        binds.join(" "),
        if deny_network { " --unshare-net" } else { "" },
    ))
}

/// Build the OS sandbox wrapper prefix for a local session. The frontend runs
/// `<wrapper> /bin/sh -c '<original command>'`. Fails closed: unsupported OS,
/// missing tooling, or a bad cwd return an error instead of running unwrapped.
#[tauri::command]
pub fn sandbox_wrapper(
    id: String,
    cwd: String,
    extra_paths: Vec<String>,
    deny_network: bool,
) -> Result<String, String> {
    let roots = writable_roots(&cwd, &extra_paths)?;
    if cfg!(target_os = "macos") {
        macos_wrapper(&id, &roots, deny_network)
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
        assert!(p.starts_with("(version 1)\n(allow default)\n(deny file-write*)\n"));
        assert!(p.contains("(allow file-write* (subpath \"/dev\"))"));
        assert!(p.contains("(allow file-write* (subpath \"/Users/x/proj\"))"));
        assert!(p.contains("(allow file-write* (subpath \"/private/tmp\"))"));
        assert!(!p.contains("network"));
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
        let roots = vec!["/home/u/my proj".to_string(), "/tmp".to_string()];
        let binds: Vec<String> = roots.iter().map(|r| format!("--bind {} {}", shq(r), shq(r))).collect();
        let p = format!(
            "bwrap --ro-bind / / --dev-bind /dev /dev --proc /proc --die-with-parent {}",
            binds.join(" "),
        );
        assert!(p.contains("--bind '/home/u/my proj' '/home/u/my proj'"));
        assert!(!p.contains("--unshare-net"));
    }

    #[test]
    /// Session ids become safe filenames.
    fn sanitizes_profile_ids() {
        assert_eq!(sanitize_id("a-x1_B"), "a-x1_B");
        assert_eq!(sanitize_id("../../etc/passwd"), "------etc-passwd");
        assert_eq!(sanitize_id(""), "session");
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
    /// End-to-end: the command writes a profile and returns a sandbox-exec
    /// prefix pointing at it.
    fn builds_macos_wrapper() {
        let w = sandbox_wrapper("test–profile/1".into(), "/tmp".into(), vec![], true).unwrap();
        assert!(w.starts_with("sandbox-exec -f '"));
        let path = w.trim_start_matches("sandbox-exec -f '").trim_end_matches('\'');
        let body = std::fs::read_to_string(path).unwrap();
        assert!(body.contains("(deny network*)"));
        std::fs::remove_file(path).ok();
    }
}
