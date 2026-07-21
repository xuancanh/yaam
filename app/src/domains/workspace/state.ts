// Workspace scoping: swap the active workspace's flat AppState fields with a
// stored per-workspace slice. Pure state transitions.
import type { AppState, Agent, WorkspaceData } from '../../core/types'
import { mkId } from '../../shared/id'
import { groupsFromLegacy, removeFromGroups } from '../session/layout-state'

/** True when the session's home workspace is currently spun out into a
 *  satellite OS window. This window must not run settle/scan/monitor/watcher
 *  work for it — the satellite owns that workspace's slice, and any flag
 *  written here is clobbered by the next ws:sync merge anyway. */
export function isDetachedAgent(s: AppState, agent: Pick<Agent, 'workspaceId'>): boolean {
  return (s.detachedWorkspaces ?? []).includes(agent.workspaceId ?? s.activeWorkspace)
}

/** Create the isolated state slice for a new workspace. */
export function emptyScoped(greeting: string): WorkspaceData {
  return {
    groups: [], activeGroup: null, minimizedIds: [],
    messages: [{ id: mkId('m'), role: 'master', kind: 'text', text: greeting }],
    crons: [], tasks: [], events: [], notifications: [], pendingMasterNotes: [],
  }
}

/** Snapshot the active workspace's flat fields into a storable workspace slice. */
export function scopedFromState(s: AppState): WorkspaceData {
  return {
    groups: s.groups, activeGroup: s.activeGroup, minimizedIds: s.minimizedIds,
    messages: s.messages, crons: s.crons, tasks: s.tasks,
    events: s.events, notifications: s.notifications, pendingMasterNotes: [],
  }
}

/** Replace the flat active-workspace fields with a workspace slice. */
export function applyScoped(s: AppState, d: WorkspaceData): AppState {
  const { groups, activeGroup } = d.groups
    ? { groups: d.groups, activeGroup: d.activeGroup && d.groups.some(g => g.id === d.activeGroup) ? d.activeGroup : d.groups[0]?.id ?? null }
    : groupsFromLegacy(d)
  return {
    ...s,
    groups, activeGroup, minimizedIds: d.minimizedIds,
    messages: d.messages, crons: d.crons, tasks: d.tasks,
    events: d.events, notifications: d.notifications,
  }
}

/** Drop a session from a stashed workspace slice's layout containers. */
function removeFromSlice(d: WorkspaceData, id: string): WorkspaceData {
  const groups = (d.groups ?? [])
    .map(g => (g.slots.includes(id)
      ? { ...g, slots: g.slots.map(x => (x === id ? null : x)), maximizedPane: null }
      : g))
    .filter(g => g.slots.some(Boolean))
  return {
    ...d,
    groups,
    activeGroup: groups.some(g => g.id === d.activeGroup) ? d.activeGroup : groups[0]?.id ?? null,
    minimizedIds: (d.minimizedIds ?? []).filter(x => x !== id),
  }
}

/** Reassign a session to another workspace. Pulls it out of the source
 *  workspace's layout containers (groups, dock); it arrives as a loose tab.
 *  Pure state only — the terminal registry is keyed by session id, so the
 *  running process and scrollback survive the move untouched. */
export function moveSessionIn(s: AppState, id: string, wsId: string): AppState {
  const agent = s.agents.find(a => a.id === id)
  if (!agent || !s.workspaces.some(w => w.id === wsId)) return s
  const from = agent.workspaceId ?? s.activeWorkspace
  if (from === wsId) return s
  let next = s
  if (from === s.activeWorkspace) {
    next = { ...s, ...removeFromGroups(s, id), minimizedIds: s.minimizedIds.filter(x => x !== id) }
  } else if (s.workspaceData[from]) {
    next = { ...s, workspaceData: { ...s.workspaceData, [from]: removeFromSlice(s.workspaceData[from], id) } }
  }
  return { ...next, agents: next.agents.map(a => (a.id === id ? { ...a, workspaceId: wsId } : a)) }
}

/** Stash the current workspace and hydrate the target workspace atomically. */
export function switchWorkspaceIn(s: AppState, id: string, greeting: string): AppState {
  if (id === s.activeWorkspace || !s.workspaces.some(w => w.id === id)) return s
  const stash = { ...s.workspaceData, [s.activeWorkspace]: scopedFromState(s) }
  const target = stash[id] ?? emptyScoped(greeting)
  const rest = { ...stash }
  delete rest[id]
  return applyScoped({ ...s, activeWorkspace: id, workspaceData: rest, view: 'workspace' }, target)
}
