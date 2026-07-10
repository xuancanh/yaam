// Lightweight per-session diff stats (+added −removed · files) for run lists.
// Plain sessions count uncommitted work vs HEAD (`git diff --numstat HEAD` plus
// untracked files); worktree sessions count everything vs the fork point via
// the existing worktreeDiff (committed + uncommitted — exactly what a merge
// would bring back); machine sessions run the same numstat over the shared SSH
// connection. All fetches are best-effort: any failure yields undefined and
// the UI simply shows no stats.
import { useEffect, useRef, useState } from 'react'
import { execCommand, worktreeDiff } from '../../core/native'
import type { Machine } from '../../core/types'
import { shq, sshPrefix } from './remote-machine'

export interface DiffStats {
  add: number
  del: number
  files: number
}

/** Sum a `git diff --numstat` output; non-numstat lines (untracked paths
 *  appended by the stats command) count as one file each. Binary files show
 *  `-\t-\tpath` — counted as a file with no line stats. */
export function parseNumstat(output: string): DiffStats {
  const st: DiffStats = { add: 0, del: 0, files: 0 }
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (m) {
      st.add += m[1] === '-' ? 0 : Number(m[1])
      st.del += m[2] === '-' ? 0 : Number(m[2])
    }
    st.files += 1
  }
  return st
}

/** Count +/− lines and files from a unified diff (worktree fork-point diffs). */
export function statsFromUnifiedDiff(diff: string): DiffStats {
  const st: DiffStats = { add: 0, del: 0, files: 0 }
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) st.files += 1
    else if (line.startsWith('+') && !line.startsWith('+++')) st.add += 1
    else if (line.startsWith('-') && !line.startsWith('---')) st.del += 1
  }
  return st
}

/** Shell command printing numstat vs HEAD plus untracked paths for one repo.
 *  Untracked lines have no tabs, so parseNumstat tells the two apart. */
export function numstatCommand(root: string): string {
  const d = shq(root)
  return `git -C ${d} diff --numstat HEAD 2>/dev/null; git -C ${d} ls-files --others --exclude-standard 2>/dev/null | head -200`
}

interface StatsSource {
  id: string
  cwd?: string
  machine?: Machine
  worktree?: { root: string; workdir: string }
}

/** Best-effort stats for one session; undefined when there is nothing to
 *  measure (no cwd, not a repo, host unreachable…). */
export async function fetchDiffStats(src: StatsSource): Promise<DiffStats | undefined> {
  try {
    if (src.worktree) {
      const repos = await worktreeDiff(src.worktree.root)
      return repos.reduce<DiffStats>((acc, r) => {
        if (r.error) return acc
        const s = statsFromUnifiedDiff(r.diff)
        return { add: acc.add + s.add, del: acc.del + s.del, files: acc.files + s.files }
      }, { add: 0, del: 0, files: 0 })
    }
    if (!src.cwd) return undefined
    const inner = numstatCommand(src.cwd)
    const cmd = src.machine ? `${sshPrefix(src.machine, { controlId: src.id })} ${shq(inner)}` : inner
    const { code, output } = await execCommand(cmd, undefined, 15_000)
    if (code !== 0) return undefined
    return parseNumstat(output)
  } catch {
    return undefined
  }
}

/** Poll diff stats for a set of sessions while mounted. Sequential per sweep
 *  (one SSH/git process at a time) so a big fleet doesn't stampede. */
export function useDiffStats(sources: StatsSource[], intervalMs = 15_000): Record<string, DiffStats> {
  const [stats, setStats] = useState<Record<string, DiffStats>>({})
  // the sweep reads the latest sources without retriggering on identity churn
  const ref = useRef(sources)
  ref.current = sources
  const key = sources.map(s => s.id).join(',')

  useEffect(() => {
    let live = true
    let timer: number | undefined
    const sweep = async () => {
      for (const src of ref.current) {
        if (!live) return
        const st = await fetchDiffStats(src)
        if (!live) return
        if (st) setStats(cur => (cur[src.id]?.add === st.add && cur[src.id]?.del === st.del && cur[src.id]?.files === st.files ? cur : { ...cur, [src.id]: st }))
      }
      if (live) timer = window.setTimeout(() => { void sweep() }, intervalMs)
    }
    void sweep()
    return () => { live = false; window.clearTimeout(timer) }
  }, [key, intervalMs])

  return stats
}
