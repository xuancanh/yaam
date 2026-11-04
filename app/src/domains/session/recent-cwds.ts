// Recently used working folders for the new-session dialog. Remembered per
// target (local or a saved machine) because local and remote paths differ.
import type { OrchestrationSettings, SessionRecord } from '../../core/entities'

export interface RecentCwd { path: string; machineId?: string; at: number }

const MAX_RECENT = 12

/** Normalize a typed path so `~/x`, `~/x/` and `~/x ` collapse to one entry. */
function norm(path: string): string {
  const p = path.trim()
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Move `path` to the front of the list for its target, capping the list. */
export function rememberCwd(list: RecentCwd[] | undefined, path: string, machineId: string | undefined, at = Date.now()): RecentCwd[] {
  const p = norm(path)
  if (!p) return list ?? []
  const m = machineId || undefined
  const rest = (list ?? []).filter(r => !(r.path === p && (r.machineId || undefined) === m))
  return [{ path: p, ...(m ? { machineId: m } : {}), at }, ...rest].slice(0, MAX_RECENT)
}

/** Recent folders for one target: remembered launches first, then folders of
 *  existing sessions (so the list is useful before anything was remembered).
 *  Worktree mirrors are skipped: they are YAAM's copies, not user folders. */
export function recentCwdsFor(
  settings: Pick<OrchestrationSettings, 'recentCwds' | 'defaultCwd'>,
  agents: Pick<SessionRecord, 'cwd' | 'machineId' | 'kind'>[],
  machineId: string | undefined,
  limit = 6,
): string[] {
  const m = machineId || undefined
  const out: string[] = []
  const add = (path: string | undefined) => {
    const p = norm(path ?? '')
    if (!p || p.includes('/.yaam/worktrees/') || out.includes(p)) return
    out.push(p)
  }
  for (const r of settings.recentCwds ?? []) if ((r.machineId || undefined) === m) add(r.path)
  for (let i = agents.length - 1; i >= 0; i--) {
    const a = agents[i]
    if (a.kind === 'chat' || (a.machineId || undefined) !== m) continue
    add(a.cwd)
  }
  if (!m) add(settings.defaultCwd)
  return out.slice(0, limit)
}

/** Split a path into a display name (last segment) and its parent. */
export function splitPath(path: string): { name: string; parent: string } {
  const p = norm(path)
  const i = p.lastIndexOf('/')
  if (i < 0) return { name: p, parent: '' }
  if (i === 0) return { name: p.slice(1) || '/', parent: p.length > 1 ? '/' : '' }
  return { name: p.slice(i + 1), parent: p.slice(0, i) }
}
