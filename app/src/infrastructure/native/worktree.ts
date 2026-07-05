// Worktree adapter: isolate a session/task in git worktrees (single repo or a
// folder of sub-repos), inspect its diff vs the fork point, merge back, and
// clean up. Desktop only — the backend shells out to git.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface WorktreeRepo {
  name: string
  source: string
  branch: string
  base_ref: string
}

export interface WorktreeInfo {
  root: string
  base: string
  slug: string
  /** what the session should use as its cwd (root, or the single repo) */
  workdir: string
  repos: WorktreeRepo[]
}

export interface WorktreeRepoDiff {
  name: string
  diff: string
  error: string | null
}

export interface WorktreeMergeResult {
  name: string
  /** merged | skipped | error */
  status: string
  detail: string
}

/** Mirror `baseCwd` under ~/.yaam/worktrees/<slug> with one worktree per repo. */
export async function worktreeCreate(baseCwd: string, slug: string): Promise<WorktreeInfo> {
  if (!isTauri) throw new Error('worktrees require the desktop app')
  return await invoke<WorktreeInfo>('worktree_create', { baseCwd, slug })
}

/** Per-repo diff of the worktree against its fork point (new files included). */
export async function worktreeDiff(root: string): Promise<WorktreeRepoDiff[]> {
  if (!isTauri) throw new Error('worktrees require the desktop app')
  return await invoke<WorktreeRepoDiff[]>('worktree_diff', { root })
}

/** Commit outstanding work and merge each repo's isolation branch back. */
export async function worktreeMerge(root: string, message: string): Promise<WorktreeMergeResult[]> {
  if (!isTauri) throw new Error('worktrees require the desktop app')
  return await invoke<WorktreeMergeResult[]>('worktree_merge', { root, message })
}

/** Remove the worktrees (and by default their branches) and the mirror folder. */
export async function worktreeRemove(root: string, deleteBranch = true): Promise<void> {
  if (!isTauri) return
  await invoke('worktree_remove', { root, deleteBranch })
}
