//! CLI session detection: map a spawned agent process to the conversation file
//! its CLI created, so the session can be resumed later. Robust for stores that
//! aren't cwd-scoped (codex, opencode) and for multiple concurrent sessions.
use crate::core::util::expand_tilde;

/// Collect candidate session files whose creation time falls in [since, until].
/// Creation time (not mtime) is used so a session another conversation keeps
/// appending to can't shadow the file our child just created.
fn files_in_window(
    dir: &std::path::Path,
    since_ms: u64,
    until_ms: u64,
    recurse: bool,
    matches: &dyn Fn(&std::path::Path) -> bool,
    out: &mut Vec<(u64, std::path::PathBuf)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recurse {
                files_in_window(&path, since_ms, until_ms, true, matches, out);
            }
            continue;
        }
        if !matches(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let created = meta
            .created()
            .or_else(|_| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        if let Some(created) = created {
            if created >= since_ms && created <= until_ms {
                out.push((created, path));
            }
        }
    }
}

/// Turn a session file path into the CLI's resume id for the given kind.
fn derive_session_id(kind: &str, path: &std::path::Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    match kind {
        // ~/.codex/sessions/.../rollout-<ts>-<uuid>.jsonl → trailing 36-char UUID
        "codex" => {
            if stem.len() >= 36 {
                Some(stem[stem.len() - 36..].to_string())
            } else {
                Some(stem)
            }
        }
        // claude: <id>.jsonl ; opencode: ses_<id>.json — the stem is the id
        _ => Some(stem),
    }
}

/// Detect the session id a CLI created after `since_ms`. Fix for shared /
/// non-cwd-scoped stores (codex, opencode) and multiple concurrent sessions:
/// pick the EARLIEST file in the window whose id isn't already claimed by
/// another live session, rather than the newest in the dir.
pub fn detect(kind: &str, cwd: Option<String>, since_ms: f64, exclude: &[String]) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let since = since_ms as u64;
    // window upper bound: the file appears within seconds of spawn; a generous
    // cap keeps a much-later sibling's file from being adopted by a late probe
    let until = since.saturating_add(180_000);

    let (dir, recurse, matcher): (std::path::PathBuf, bool, Box<dyn Fn(&std::path::Path) -> bool>) =
        match kind {
            "claude" => {
                // ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl (cwd-scoped)
                let base = expand_tilde(&cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| home.clone()));
                let encoded = base.replace(['/', '.'], "-");
                let project = std::path::PathBuf::from(&home).join(".claude/projects").join(encoded);
                (project, false, Box::new(|p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl")))
            }
            "codex" => {
                // ~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl (NOT cwd-scoped)
                let dir = std::path::PathBuf::from(&home).join(".codex/sessions");
                (dir, true, Box::new(|p: &std::path::Path| p.extension().and_then(|e| e.to_str()) == Some("jsonl")))
            }
            "opencode" => {
                // ~/.local/share/opencode/storage/**/ses_<id>.json (NOT cwd-scoped;
                // sessions live in SQLite + these per-session json fragments)
                let dir = std::path::PathBuf::from(&home).join(".local/share/opencode/storage");
                (dir, true, Box::new(|p: &std::path::Path| {
                    p.extension().and_then(|e| e.to_str()) == Some("json")
                        && p.file_stem().and_then(|s| s.to_str()).map(|s| s.starts_with("ses_")).unwrap_or(false)
                }))
            }
            _ => return None,
        };

    let mut candidates: Vec<(u64, std::path::PathBuf)> = Vec::new();
    files_in_window(&dir, since, until, recurse, &matcher, &mut candidates);
    // earliest first: the first file to appear after we spawned is most likely ours
    candidates.sort_by_key(|(created, _)| *created);

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (_, path) in candidates {
        let Some(id) = derive_session_id(kind, &path) else { continue };
        // one id can map to several files (opencode writes several fragments);
        // consider each id once, in earliest-creation order
        if !seen.insert(id.clone()) {
            continue;
        }
        if !exclude.contains(&id) {
            return Some(id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::derive_session_id;
    use std::path::Path;

    #[test]
    /// Codex ids are the trailing 36-char UUID of the rollout filename; claude
    /// and opencode ids are the whole file stem.
    fn derives_session_ids_per_cli() {
        assert_eq!(
            derive_session_id("codex", Path::new(
                "/x/rollout-2026-03-29T22-06-43-019d3d23-176a-7663-baaa-fdc8cef1e988.jsonl")),
            Some("019d3d23-176a-7663-baaa-fdc8cef1e988".to_string()),
        );
        assert_eq!(
            derive_session_id("claude", Path::new("/x/abc-123-def.jsonl")),
            Some("abc-123-def".to_string()),
        );
        assert_eq!(
            derive_session_id("opencode", Path::new("/x/ses_1a8d3093dffeV2rBjv.json")),
            Some("ses_1a8d3093dffeV2rBjv".to_string()),
        );
    }
}
