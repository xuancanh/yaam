//! Small helpers shared across backend domains.

/// Expand a leading home-directory shorthand before filesystem or process use.
pub fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
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
}
