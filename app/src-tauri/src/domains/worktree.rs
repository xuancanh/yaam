//! Git worktree isolation for sessions and board tasks. A working folder may
//! be a single git repo OR a plain folder whose immediate subfolders are each
//! their own repo (multi-repo workspace); both get mirrored under
//! `~/.yaam/worktrees/<slug>/` with one `git worktree` (branch `yaam/<slug>`)
//! per repo and symlinks for non-repo entries, so an agent sees the same
//! folder shape without touching the original checkouts.
use crate::util::expand_tilde;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorktreeRepo {
    /// entry name under the worktree root ("." when the base itself is the repo)
    pub name: String,
    /// absolute path of the original repo checkout
    pub source: String,
    /// isolation branch (yaam/<slug>)
    pub branch: String,
    /// branch (or detached sha) the worktree forked from
    pub base_ref: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorktreeInfo {
    /// folder holding the mirrored workspace
    pub root: String,
    /// original base folder
    pub base: String,
    pub slug: String,
    /// what the session should use as its cwd (root, or the single repo)
    pub workdir: String,
    pub repos: Vec<WorktreeRepo>,
}

#[derive(Serialize)]
pub struct RepoDiff {
    pub name: String,
    pub diff: String,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct MergeResult {
    pub name: String,
    /// merged | skipped (no changes) | error
    pub status: String,
    pub detail: String,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn sanitize_slug(slug: &str) -> String {
    let s: String = slug
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    s.trim_matches('-').to_string()
}

fn meta_path(root: &Path) -> PathBuf {
    root.join(".yaam-worktree.json")
}

fn write_metadata(root: &Path, info: &WorktreeInfo) -> Result<(), String> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(meta_path(root)).map_err(|e| e.to_string())?;
    file.write_all(serde_json::to_string_pretty(info).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

fn rollback_created(root: &Path, repos: &[WorktreeRepo], branch: &str) {
    for repo in repos.iter().rev() {
        let source = PathBuf::from(&repo.source);
        let dest = root.join(&repo.name);
        let _ = git(&source, &["worktree", "remove", "--force", &dest.to_string_lossy()]);
        let _ = git(&source, &["branch", "-D", branch]);
    }
    let _ = std::fs::remove_dir_all(root);
}

fn managed_base() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".yaam/worktrees"))
}

fn load_info(root: &str) -> Result<WorktreeInfo, String> {
    let root = std::fs::canonicalize(expand_tilde(root))
        .map_err(|e| format!("worktree unavailable: {e}"))?;
    let managed = std::fs::canonicalize(managed_base()?)
        .map_err(|e| format!("managed worktree folder unavailable: {e}"))?;
    if root.parent() != Some(managed.as_path()) {
        return Err("refusing a worktree outside ~/.yaam/worktrees".to_string());
    }
    let text = std::fs::read_to_string(meta_path(&root))
        .map_err(|e| format!("not a yaam worktree ({e})"))?;
    let info: WorktreeInfo = serde_json::from_str(&text)
        .map_err(|e| format!("bad worktree metadata: {e}"))?;
    if Path::new(&info.root) != root
        || info.slug.is_empty()
        || sanitize_slug(&info.slug) != info.slug
        || info.repos.is_empty()
        || !Path::new(&info.workdir).starts_with(&root)
        || info.repos.iter().any(|repo| {
            repo.name.is_empty()
                || repo.name == "."
                || repo.name == ".."
                || repo.name.contains('/')
                || repo.name.contains('\\')
                || repo.branch != format!("yaam/{}", info.slug)
        })
    {
        return Err("worktree metadata failed provenance validation".to_string());
    }
    Ok(info)
}

/// The repos to isolate: the base itself, or its immediate repo subfolders.
fn detect_repos(base: &Path) -> Vec<(String, PathBuf)> {
    if is_repo(base) {
        let name = base
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".into());
        return vec![(name, base.to_path_buf())];
    }
    let mut repos = Vec::new();
    if let Ok(entries) = std::fs::read_dir(base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && is_repo(&path) {
                repos.push((entry.file_name().to_string_lossy().to_string(), path));
            }
        }
    }
    repos.sort_by(|a, b| a.0.cmp(&b.0));
    repos
}

fn create_impl(base_cwd: &str, slug: &str) -> Result<WorktreeInfo, String> {
    let base = std::fs::canonicalize(expand_tilde(base_cwd))
        .map_err(|e| format!("working folder unavailable: {e}"))?;
    let slug = sanitize_slug(slug);
    if slug.is_empty() {
        return Err("empty worktree slug".into());
    }
    let repos = detect_repos(&base);
    if repos.is_empty() {
        return Err(format!(
            "no git repository found at {} (or in its immediate subfolders)",
            base.display()
        ));
    }
    let single = repos.len() == 1 && repos[0].1 == base;
    let branch = format!("yaam/{slug}");
    // Preflight every source before changing the first repository. This both
    // gives a clear collision error and proves any branch created below belongs
    // to this transaction, so rollback may safely delete it.
    for (name, source) in &repos {
        if git(source, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).is_ok() {
            return Err(format!("{name}: branch {branch} already exists"));
        }
    }
    let root = managed_base()?.join(&slug);
    if root.exists() {
        return Err(format!("worktree {} already exists", root.display()));
    }
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let mut out_repos = Vec::new();
    for (name, source) in &repos {
        let base_ref = match git(source, &["symbolic-ref", "--short", "HEAD"])
            .or_else(|_| git(source, &["rev-parse", "HEAD"])) {
            Ok(base_ref) => base_ref,
            Err(e) => {
                rollback_created(&root, &out_repos, &branch);
                return Err(format!("{name}: {e}"));
            }
        };
        let dest = root.join(name);
        if let Err(e) = git(
            source,
            &["worktree", "add", "-b", &branch, &dest.to_string_lossy(), "HEAD"],
        ) {
            // The failing git may already have created its branch/directory.
            let _ = git(source, &["worktree", "remove", "--force", &dest.to_string_lossy()]);
            let _ = git(source, &["branch", "-D", &branch]);
            rollback_created(&root, &out_repos, &branch);
            return Err(format!("{name}: {e}"));
        }
        out_repos.push(WorktreeRepo {
            name: name.clone(),
            source: source.to_string_lossy().to_string(),
            branch: branch.clone(),
            base_ref,
        });
    }

    // multi-repo folders: mirror non-repo entries (config files, docs, …) as
    // symlinks so the agent sees the full workspace shape
    #[cfg(unix)]
    if !single {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == ".DS_Store" || repos.iter().any(|(n, _)| *n == name) {
                    continue;
                }
                let _ = std::os::unix::fs::symlink(entry.path(), root.join(&name));
            }
        }
    }

    let workdir = if single {
        root.join(&repos[0].0)
    } else {
        root.clone()
    };
    let info = WorktreeInfo {
        root: root.to_string_lossy().to_string(),
        base: base.to_string_lossy().to_string(),
        slug,
        workdir: workdir.to_string_lossy().to_string(),
        repos: out_repos,
    };
    if let Err(e) = write_metadata(&root, &info) {
        rollback_created(&root, &info.repos, &branch);
        return Err(e);
    }
    Ok(info)
}

fn diff_impl(root: &str) -> Result<Vec<RepoDiff>, String> {
    let info = load_info(root)?;
    let root = PathBuf::from(&info.root);
    let mut out = Vec::new();
    for repo in &info.repos {
        let wt = root.join(&repo.name);
        // intent-to-add so brand-new files appear in the diff
        let _ = git(&wt, &["add", "-A", "-N", "."]);
        match git(&wt, &["diff", "--no-color", &repo.base_ref]) {
            Ok(diff) => out.push(RepoDiff { name: repo.name.clone(), diff, error: None }),
            Err(e) => out.push(RepoDiff { name: repo.name.clone(), diff: String::new(), error: Some(e) }),
        }
    }
    Ok(out)
}

fn merge_impl(root: &str, message: &str) -> Result<Vec<MergeResult>, String> {
    let info = load_info(root)?;
    let root_path = PathBuf::from(&info.root);
    let mut out = Vec::new();
    for repo in &info.repos {
        let wt = root_path.join(&repo.name);
        let source = PathBuf::from(&repo.source);
        let result = (|| -> Result<(String, String), String> {
            // commit any uncommitted work on the isolation branch
            git(&wt, &["add", "-A"])?;
            let dirty = git(&wt, &["status", "--porcelain"])?;
            if !dirty.is_empty() {
                git(&wt, &["commit", "-m", message, "--no-verify"])?;
            }
            let ahead = git(
                &wt,
                &["rev-list", "--count", &format!("{}..{}", repo.base_ref, repo.branch)],
            )?;
            if ahead == "0" {
                return Ok(("skipped".into(), "no changes".into()));
            }
            // the source checkout must still be on the branch we forked from
            let current = git(&source, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_default();
            if current != repo.base_ref {
                return Err(format!(
                    "source is on '{current}', expected '{}' — switch branches and retry",
                    repo.base_ref
                ));
            }
            match git(&source, &["merge", "--no-ff", "--no-edit", &repo.branch]) {
                Ok(_) => Ok(("merged".into(), format!("{ahead} commit(s) merged"))),
                Err(e) => {
                    let _ = git(&source, &["merge", "--abort"]);
                    Err(format!("merge conflict — aborted: {e}"))
                }
            }
        })();
        match result {
            Ok((status, detail)) => out.push(MergeResult { name: repo.name.clone(), status, detail }),
            Err(e) => out.push(MergeResult { name: repo.name.clone(), status: "error".into(), detail: e }),
        }
    }
    Ok(out)
}

fn remove_impl(root: &str, delete_branch: bool) -> Result<(), String> {
    let info = load_info(root)?;
    let root_path = PathBuf::from(&info.root);
    for repo in &info.repos {
        let wt = root_path.join(&repo.name);
        let source = PathBuf::from(&repo.source);
        let _ = git(&source, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
        if delete_branch {
            let _ = git(&source, &["branch", "-D", &repo.branch]);
        }
    }
    std::fs::remove_dir_all(&root_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn worktree_create(base_cwd: String, slug: String) -> Result<WorktreeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || create_impl(&base_cwd, &slug))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_diff(root: String) -> Result<Vec<RepoDiff>, String> {
    tauri::async_runtime::spawn_blocking(move || diff_impl(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_merge(root: String, message: String) -> Result<Vec<MergeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || merge_impl(&root, &message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_remove(root: String, delete_branch: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_impl(&root, delete_branch.unwrap_or(true)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{create_impl, diff_impl, load_info, merge_impl, remove_impl};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn sh(dir: &Path, cmd: &str) {
        let out = Command::new("/bin/sh")
            .args(["-c", cmd])
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{cmd}: {}", String::from_utf8_lossy(&out.stderr));
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(label: &str) -> Self {
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("yaam-wt-{label}-{}-{id}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_forged_metadata_outside_the_managed_worktree_folder() {
        let dir = TestDir::new("forged");
        std::fs::write(
            dir.0.join(".yaam-worktree.json"),
            r#"{"root":"/tmp","base":"/tmp","slug":"fake","workdir":"/tmp","repos":[]}"#,
        )
        .unwrap();
        assert!(load_info(&dir.0.to_string_lossy())
            .unwrap_err()
            .contains("outside ~/.yaam/worktrees"));
    }

    #[test]
    fn multi_repo_creation_rolls_back_when_a_later_repo_fails() {
        let base = TestDir::new("rollback-base");
        let first = base.0.join("a-first");
        let second = base.0.join("b-second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        init_repo(&first);
        sh(&second, "git init -q -b main && git config user.email t@t && git config user.name t");
        let slug = format!("rollback-{}", std::process::id());

        let err = create_impl(&base.0.to_string_lossy(), &slug).unwrap_err();
        assert!(err.contains("b-second"));
        let managed = PathBuf::from(std::env::var("HOME").unwrap()).join(".yaam/worktrees").join(&slug);
        assert!(!managed.exists());
        let branches = Command::new("git").args(["branch", "--list", &format!("yaam/{slug}")])
            .current_dir(&first).output().unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
    }

    fn init_repo(dir: &Path) {
        sh(dir, "git init -q -b main && git config user.email t@t && git config user.name t && echo hi > a.txt && git add -A && git commit -qm init");
    }

    #[test]
    fn isolates_a_single_repo_and_merges_changes_back() {
        let base = TestDir::new("single");
        init_repo(&base.0);
        let slug = format!("t-single-{}", std::process::id());

        let info = create_impl(&base.0.to_string_lossy(), &slug).unwrap();
        assert_eq!(info.repos.len(), 1);
        assert!(info.workdir.ends_with(&format!("{slug}/{}", base.0.file_name().unwrap().to_string_lossy())));

        // agent edits inside the worktree; the original stays untouched
        std::fs::write(PathBuf::from(&info.workdir).join("a.txt"), "changed\n").unwrap();
        std::fs::write(PathBuf::from(&info.workdir).join("new.txt"), "brand new\n").unwrap();
        assert_eq!(std::fs::read_to_string(base.0.join("a.txt")).unwrap(), "hi\n");

        let diffs = diff_impl(&info.root).unwrap();
        assert!(diffs[0].diff.contains("changed"));
        assert!(diffs[0].diff.contains("new.txt"));

        let merged = merge_impl(&info.root, "yaam: test task").unwrap();
        assert_eq!(merged[0].status, "merged", "{}", merged[0].detail);
        assert_eq!(std::fs::read_to_string(base.0.join("a.txt")).unwrap(), "changed\n");
        assert!(base.0.join("new.txt").exists());

        remove_impl(&info.root, true).unwrap();
        assert!(!PathBuf::from(&info.root).exists());
    }

    #[test]
    fn isolates_a_folder_of_repos_and_mirrors_loose_entries() {
        let base = TestDir::new("multi");
        let app = base.0.join("app");
        let api = base.0.join("api");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(&api).unwrap();
        init_repo(&app);
        init_repo(&api);
        std::fs::write(base.0.join("README.md"), "workspace docs").unwrap();
        let slug = format!("t-multi-{}", std::process::id());

        let info = create_impl(&base.0.to_string_lossy(), &slug).unwrap();
        assert_eq!(info.repos.len(), 2);
        assert_eq!(info.workdir, info.root);
        let root = PathBuf::from(&info.root);
        assert!(root.join("app/a.txt").exists());
        assert!(root.join("api/a.txt").exists());
        // loose files are mirrored via symlink
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "workspace docs");

        // change only one repo; merge reports the other as skipped
        std::fs::write(root.join("api/a.txt"), "api change\n").unwrap();
        let merged = merge_impl(&info.root, "yaam: multi").unwrap();
        let api_res = merged.iter().find(|m| m.name == "api").unwrap();
        let app_res = merged.iter().find(|m| m.name == "app").unwrap();
        assert_eq!(api_res.status, "merged", "{}", api_res.detail);
        assert_eq!(app_res.status, "skipped");
        assert_eq!(std::fs::read_to_string(api.join("a.txt")).unwrap(), "api change\n");

        remove_impl(&info.root, true).unwrap();
    }

    #[test]
    fn rejects_folders_without_any_repo() {
        let base = TestDir::new("none");
        let err = create_impl(&base.0.to_string_lossy(), "t-none").unwrap_err();
        assert!(err.contains("no git repository"));
    }
}
