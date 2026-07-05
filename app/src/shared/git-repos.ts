// Multi-repo working folders: a session/task cwd may be a git repo OR a plain
// folder whose immediate subfolders are each their own repo. These helpers let
// every git surface (git panel, review drawer, review queue) treat both shapes
// the same way.
import { gitDiff, gitStatus, listDir } from '../core/native'

/** The git repos reachable from `cwd`: itself, or its immediate repo subfolders. */
export async function detectRepoDirs(cwd: string): Promise<string[]> {
  try {
    await gitStatus(cwd)
    return [cwd]
  } catch {
    const entries = await listDir(cwd).catch(() => [])
    const repos: string[] = []
    for (const e of entries.filter(x => x.isDir && x.name !== '.git').slice(0, 16)) {
      try {
        await gitStatus(e.path)
        repos.push(e.path)
      } catch { /* not a repo */ }
    }
    return repos
  }
}

/** Working-tree diff(s) under `cwd`, one entry per repo. Throws when there is
 *  no repo at all; `name` is '' for the single-repo case. */
export async function multiRepoDiff(cwd: string): Promise<{ name: string; diff: string }[]> {
  const repos = await detectRepoDirs(cwd)
  if (!repos.length) throw new Error(`no git repository found at ${cwd} (or in its immediate subfolders)`)
  if (repos.length === 1 && repos[0] === cwd) return [{ name: '', diff: await gitDiff(cwd) }]
  return await Promise.all(repos.map(async r => ({
    name: r.slice(r.lastIndexOf('/') + 1),
    diff: await gitDiff(r).catch(e => `error: ${e instanceof Error ? e.message : e}`),
  })))
}
