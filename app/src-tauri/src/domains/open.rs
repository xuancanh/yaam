//! Open a URL in the user's default browser — the terminal's ctrl/cmd+click
//! link action. Scheme-restricted to http(s): terminal output is untrusted, so
//! file:, javascript:, and custom app schemes must never reach the OS opener.
fn validate(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err("only http(s) links can be opened".into())
    }
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    validate(&url)?;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        // the empty string is the window title `start` would otherwise eat
        c.args(["/C", "start", "", &url]);
        c
    };
    cmd.spawn().map_err(|e| format!("failed to open link: {e}"))?;
    Ok(())
}

/// Open a local file or folder from the file explorer's context menu.
/// `mode`: "default" (OS default app / folder in the file manager),
/// "reveal" (select the item in the file manager), "vscode" (VS Code).
/// The path must exist — this only ever launches on user-clicked tree rows.
#[tauri::command]
pub fn open_path(path: String, mode: String) -> Result<(), String> {
    let expanded = crate::util::expand_tilde(&path);
    let p = std::path::Path::new(&expanded);
    if !p.exists() {
        return Err(format!("path does not exist: {expanded}"));
    }
    let mut cmd = match mode.as_str() {
        "default" => {
            #[cfg(target_os = "macos")]
            {
                let mut c = std::process::Command::new("open");
                c.arg(&expanded);
                c
            }
            #[cfg(target_os = "linux")]
            {
                let mut c = std::process::Command::new("xdg-open");
                c.arg(&expanded);
                c
            }
            #[cfg(target_os = "windows")]
            {
                let mut c = std::process::Command::new("explorer");
                c.arg(&expanded);
                c
            }
        }
        "reveal" => {
            #[cfg(target_os = "macos")]
            {
                let mut c = std::process::Command::new("open");
                c.args(["-R", &expanded]);
                c
            }
            #[cfg(target_os = "linux")]
            {
                // no portable "select in file manager" — open the parent dir
                let parent = p
                    .parent()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_else(|| expanded.clone());
                let mut c = std::process::Command::new("xdg-open");
                c.arg(parent);
                c
            }
            #[cfg(target_os = "windows")]
            {
                let mut c = std::process::Command::new("explorer");
                c.arg(format!("/select,{expanded}"));
                c
            }
        }
        "vscode" => {
            #[cfg(target_os = "macos")]
            {
                let mut c = std::process::Command::new("open");
                c.args(["-a", "Visual Studio Code", &expanded]);
                c
            }
            #[cfg(not(target_os = "macos"))]
            {
                let mut c = std::process::Command::new("code");
                c.arg(&expanded);
                c
            }
        }
        other => return Err(format!("unknown open mode: {other}")),
    };
    cmd.spawn().map_err(|e| format!("failed to open: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn open_path_rejects_missing_paths_and_unknown_modes() {
        assert!(super::open_path("/no/such/path/xyz".into(), "default".into()).is_err());
        // an existing path with a bogus mode is rejected before any spawn
        assert!(super::open_path("/".into(), "bogus".into()).is_err());
    }

    #[test]
    fn accepts_http_and_https_only() {
        assert!(validate("https://example.com/a?b=c").is_ok());
        assert!(validate("http://localhost:5173").is_ok());
        assert!(validate("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn rejects_dangerous_schemes() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://host/x",
            "customapp://payload",
            "  https://padded.com",
            "",
        ] {
            assert!(validate(url).is_err(), "should reject {url:?}");
        }
    }
}
