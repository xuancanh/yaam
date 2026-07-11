// Multi-repo working folders: a session/task cwd may be a git repo OR a plain
// folder whose subfolders (up to REPO_SCAN_DEPTH levels down) are each their
// own repo. These helpers let every git surface (git panel, review drawer,
// review queue) treat both shapes the same way, and run over the local fs or
// any SessionFs-shaped adapter (ssh).
import { gitDiff, gitStatus, listDir } from '../core/native'

/** how far below a plain container folder to look for repos */
export const REPO_SCAN_DEPTH = 3
const MAX_REPOS = 24
/** total directory listings per scan — bounds the probe cost over SSH */
const MAX_LISTINGS = 120
/** dependency/build trees that are never someone's reviewable repo */
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', 'vendor'])

interface ProbeEntry { name: string; path: string; isDir: boolean }
/** the two operations a scan needs — satisfied by core/native and SessionFs */
export interface RepoProbe {
  gitStatus(cwd: string): Promise<unknown>
  listDir(path: string): Promise<ProbeEntry[]>
}

/** The git repos reachable from `cwd` through `probe`: cwd itself (or the repo
 *  it sits inside), else the repo folders up to REPO_SCAN_DEPTH levels below
 *  it. A found repo is not descended into — repos nested inside it (vendored
 *  trees, submodules) belong to that repo's own diff. Detection below cwd is a
 *  `.git` entry in the listing, so one listing per folder covers both the
 *  repo check and the recursion — cheap even over SSH. */
export async function detectRepoDirsVia(probe: RepoProbe, cwd: string): Promise<string[]> {
  try {
    await probe.gitStatus(cwd) // also succeeds when cwd is *inside* a repo
    return [cwd]
  } catch { /* plain folder — scan below */ }
  const repos: string[] = []
  let listings = 0
  const scan = async (dir: string, depth: number): Promise<void> => {
    if (repos.length >= MAX_REPOS || listings >= MAX_LISTINGS) return
    listings++
    const entries = await probe.listDir(dir).catch(() => [] as ProbeEntry[])
    // .git may be a dir (normal clone) or a file (worktree/submodule checkout)
    if (depth > 0 && entries.some(e => e.name === '.git')) {
      repos.push(dir)
      return
    }
    if (depth >= REPO_SCAN_DEPTH) return
    for (const e of entries) {
      if (e.isDir && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await scan(e.path, depth + 1)
    }
  }
  await scan(cwd, 0)
  return repos
}

/** The git repos reachable from `cwd` on the local filesystem. */
export function detectRepoDirs(cwd: string): Promise<string[]> {
  return detectRepoDirsVia({ gitStatus, listDir }, cwd)
}

/** A repo path shown relative to the scanned folder (nested repos keep their
 *  intermediate folders so two `api` repos in different groups stay distinct). */
export function repoLabel(cwd: string, repo: string): string {
  const base = cwd.replace(/\/+$/, '')
  if (base && repo.startsWith(`${base}/`)) return repo.slice(base.length + 1)
  return repo.slice(repo.lastIndexOf('/') + 1) || repo
}

/** Working-tree diff(s) under `cwd`, one entry per repo. Throws when there is
 *  no repo at all; `name` is '' for the single-repo case. */
export async function multiRepoDiff(cwd: string): Promise<{ name: string; diff: string }[]> {
  const repos = await detectRepoDirs(cwd)
  if (!repos.length) throw new Error(`no git repository found at ${cwd} (or up to ${REPO_SCAN_DEPTH} levels below it)`)
  if (repos.length === 1 && repos[0] === cwd) return [{ name: '', diff: await gitDiff(cwd) }]
  return await Promise.all(repos.map(async r => ({
    name: repoLabel(cwd, r),
    diff: await gitDiff(r).catch(e => `error: ${e instanceof Error ? e.message : e}`),
  })))
}
