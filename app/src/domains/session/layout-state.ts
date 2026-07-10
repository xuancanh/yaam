// Tab-group / pane layout state (Chrome-style: each group owns its layout) and
// Chrome-like session focus. Pure state transitions over AppState.
import type { AppState, TabGroup } from '../../core/types'
import { mkId } from '../../shared/id'

/** Build a fresh tab group around the given slots. */
export function mkGroup(slots: (string | null)[], stacked = false): TabGroup {
  return {
    id: mkId('g'),
    slots: slots.length ? slots.slice(0, 4) : [null],
    stacked,
    activePane: 0,
    maximizedPane: null,
    splits: { row: 0.5, cols: [0.5, 0.5] },
  }
}

/** The group currently shown in the workspace grid. */
export function activeGroupOf(s: Pick<AppState, 'groups' | 'activeGroup'>): TabGroup | undefined {
  return s.groups.find(g => g.id === s.activeGroup)
}

/** Workspace tab-bar order: group members (slot order) then loose sessions —
 *  exactly the order the tab bar renders. Feeds ⌘1–9 / tab-cycling shortcuts. */
export function workspaceTabOrder(s: Pick<AppState, 'agents' | 'groups' | 'activeWorkspace'>): string[] {
  const live = (id: string | null): id is string => {
    const a = id ? s.agents.find(x => x.id === id) : undefined
    return !!a && !a.archived && a.kind !== 'chat'
  }
  const grouped = s.groups.flatMap(g => g.slots).filter(live)
  const inGroup = new Set(grouped)
  const loose = s.agents
    .filter(a => live(a.id) && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace && !inGroup.has(a.id))
    .map(a => a.id)
  return [...grouped, ...loose]
}

/** The focused session in the workspace (active group's active pane). */
export function activeSessionId(s: Pick<AppState, 'groups' | 'activeGroup'>): string | null {
  const g = activeGroupOf(s)
  return g?.slots[g.activePane] ?? null
}

/** Migrate legacy flat pane state (focusedIds/soloId/…) into tab groups. */
export function groupsFromLegacy(d: {
  focusedIds?: (string | null)[]
  activePane?: number
  soloId?: string | null
  paneStacked?: boolean
  paneSplits?: { row: number; cols: number[] }
}): { groups: TabGroup[]; activeGroup: string | null } {
  const groups: TabGroup[] = []
  const slots = (d.focusedIds ?? []).slice(0, 4)
  if (slots.some(Boolean)) {
    const g = mkGroup(slots, d.paneStacked ?? false)
    g.activePane = Math.max(0, Math.min(d.activePane ?? 0, g.slots.length - 1))
    if (d.paneSplits) g.splits = d.paneSplits
    groups.push(g)
  }
  let activeGroup = groups[0]?.id ?? null
  if (d.soloId && !slots.includes(d.soloId)) {
    const solo = mkGroup([d.soloId])
    groups.push(solo)
    activeGroup = solo.id
  }
  return { groups, activeGroup }
}

/** Drop a session from every group; prune groups that end up fully empty. */
export function removeFromGroups(s: AppState, id: string): Pick<AppState, 'groups' | 'activeGroup'> {
  let groups = s.groups.map(g => g.slots.includes(id)
    ? { ...g, slots: g.slots.map(x => (x === id ? null : x)), maximizedPane: null }
    : g)
  groups = groups.filter(g => g.slots.some(Boolean) || (g.id === s.activeGroup && g.slots.length > 1))
  const activeGroup = groups.some(g => g.id === s.activeGroup) ? s.activeGroup : groups[0]?.id ?? null
  return { groups, activeGroup }
}

// Chrome-like focus: reuse the session's existing group, else fill an empty
// slot of the active group, else open a new single-pane group. A session never
// appears in two groups (panes would fight over its terminal).
export function focusSessionIn(s: AppState, id: string): AppState {
  s = {
    ...s,
    agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)),
    // viewing a session clears its unread notifications
    notifications: s.notifications.map(n => (n.agentId === id && !n.read ? { ...n, read: true } : n)),
  }
  // chat sessions live in the Chat view, not in workspace tab groups
  if (s.agents.find(a => a.id === id)?.kind === 'chat') {
    return { ...s, activeChatId: id, view: 'chat' }
  }
  const minimizedIds = s.minimizedIds.filter(x => x !== id)
  const owner = s.groups.find(g => g.slots.includes(id))
  if (owner) {
    const pane = owner.slots.indexOf(id)
    return {
      ...s, minimizedIds, activeGroup: owner.id, view: 'workspace',
      groups: s.groups.map(g => g.id === owner.id
        ? { ...g, activePane: pane, maximizedPane: g.maximizedPane === null ? null : pane }
        : g),
    }
  }
  const ag = activeGroupOf(s)
  if (ag) {
    const slot = ag.slots[ag.activePane] === null ? ag.activePane : ag.slots.indexOf(null)
    if (slot >= 0) {
      return {
        ...s, minimizedIds, view: 'workspace',
        groups: s.groups.map(g => g.id === ag.id
          ? { ...g, slots: g.slots.map((x, i) => (i === slot ? id : x)), activePane: slot }
          : g),
      }
    }
  }
  const ng = mkGroup([id])
  return { ...s, minimizedIds, groups: s.groups.concat([ng]), activeGroup: ng.id, view: 'workspace' }
}
