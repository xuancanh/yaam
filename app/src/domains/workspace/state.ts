// Workspace scoping: swap the active workspace's flat AppState fields with a
// stored per-workspace slice. Pure state transitions.
import type { AppState, WorkspaceData } from '../../core/types'
import { mkId } from '../../shared/id'
import { groupsFromLegacy } from '../session/layout-state'

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

/** Stash the current workspace and hydrate the target workspace atomically. */
export function switchWorkspaceIn(s: AppState, id: string, greeting: string): AppState {
  if (id === s.activeWorkspace || !s.workspaces.some(w => w.id === id)) return s
  const stash = { ...s.workspaceData, [s.activeWorkspace]: scopedFromState(s) }
  const target = stash[id] ?? emptyScoped(greeting)
  const rest = { ...stash }
  delete rest[id]
  return applyScoped({ ...s, activeWorkspace: id, workspaceData: rest, view: 'workspace' }, target)
}
