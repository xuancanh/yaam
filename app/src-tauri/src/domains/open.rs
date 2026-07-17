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

#[cfg(test)]
mod tests {
    use super::validate;

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
