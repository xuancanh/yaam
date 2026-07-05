// Git adapter: porcelain status (+ repo root) and working-tree diffs for a
// session's directory. Desktop only.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface GitStatusResult {
  root: string
  files: { path: string; status: string }[]
}

/** Read porcelain git status plus the repository root for a session directory. */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<GitStatusResult>('git_status', { cwd })
}

/** Return the working-tree diff for one repository-relative file. */
export async function gitFileDiff(cwd: string, path: string): Promise<string> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<string>('git_file_diff', { cwd, path })
}

/** Return the complete working-tree diff for a session directory. */
export async function gitDiff(cwd: string): Promise<string> {
  if (!isTauri) throw new Error('git diff requires the desktop app')
  return await invoke<string>('git_diff', { cwd })
}
