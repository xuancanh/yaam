// Attention rollup: per-session "look at me" signals (blocked on input, or an
// unseen finish) summed per workspace for the switcher and the Dock badge,
// plus the order the "next session needing you" jump walks.
import type { AppState } from '../../core/types'
import type { Agent } from '../../core/entities'

/** 2 = blocked on the user, 1 = finished/changed and not yet viewed, 0 = calm. */
export function attentionLevel(a: Pick<Agent, 'status' | 'attention' | 'archived' | 'kind'>): 0 | 1 | 2 {
  if (a.archived || a.kind === 'chat') return 0
  if (a.status === 'needs') return 2
  return a.attention ? 1 : 0
}

export interface Rollup { blocked: number; unseen: number }

const wsOf = (s: Pick<AppState, 'workspaces' | 'activeWorkspace'>, a: Pick<Agent, 'workspaceId'>): string =>
  a.workspaceId && (s.workspaces ?? []).some(w => w.id === a.workspaceId) ? a.workspaceId : s.activeWorkspace

/** Blocked / unseen counts per workspace id. */
export function rollupByWorkspace(s: Pick<AppState, 'agents' | 'workspaces' | 'activeWorkspace'>): Map<string, Rollup> {
  const out = new Map<string, Rollup>()
  for (const a of s.agents ?? []) {
    const lvl = attentionLevel(a)
    if (!lvl) continue
    const ws = wsOf(s, a)
    const r = out.get(ws) ?? { blocked: 0, unseen: 0 }
    if (lvl === 2) r.blocked++
    else r.unseen++
    out.set(ws, r)
  }
  return out
}

/** Total for the Dock badge: everything waiting on the user, in any workspace
 *  this window owns (detached ones badge their own window). */
export function attentionTotal(s: Pick<AppState, 'agents' | 'workspaces' | 'activeWorkspace' | 'detachedWorkspaces'>): number {
  const detached = new Set(s.detachedWorkspaces ?? [])
  let n = 0
  for (const [ws, r] of rollupByWorkspace(s)) if (!detached.has(ws)) n += r.blocked + r.unseen
  return n
}

/** The next session to look at: blocked before unseen, the active workspace
 *  before others, and after `currentId` in that order so repeated presses
 *  cycle instead of sticking. Detached workspaces are skipped. */
export function nextAttention(
  s: Pick<AppState, 'agents' | 'workspaces' | 'activeWorkspace' | 'detachedWorkspaces'>,
  currentId?: string | null,
): { id: string; workspaceId: string } | null {
  const detached = new Set(s.detachedWorkspaces ?? [])
  const cands = (s.agents ?? [])
    .map((a, i) => ({ a, i, lvl: attentionLevel(a), ws: wsOf(s, a) }))
    .filter(c => c.lvl > 0 && !detached.has(c.ws))
    .sort((x, y) => (y.lvl - x.lvl) || (Number(y.ws === s.activeWorkspace) - Number(x.ws === s.activeWorkspace)) || (x.i - y.i))
  if (!cands.length) return null
  const at = cands.findIndex(c => c.a.id === currentId)
  const pick = cands[(at + 1) % cands.length]
  return { id: pick.a.id, workspaceId: pick.ws }
}
