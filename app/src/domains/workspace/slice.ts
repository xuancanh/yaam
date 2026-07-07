// Workspace domain AppState slice. Imports only entity types (never core/types),
// distinct from workspace/state.ts (which operates on the whole AppState), so
// core/types can compose this slice without an import cycle.
import type { Workspace, WorkspaceData, TabGroup } from '../../core/entities'

/** Workspaces, tab groups, and the active pane layout. */
export interface WorkspaceSlice {
  workspaces: Workspace[]
  activeWorkspace: string
  workspaceData: Record<string, WorkspaceData>
  /** Chrome-style tab groups; each keeps its own pane layout. A session lives in at most one group. */
  groups: TabGroup[]
  /** id of the group currently displayed in the workspace grid */
  activeGroup: string | null
  /** sessions minimized to the dock strip */
  minimizedIds: string[]
}

/** Initial workspace slice: one default workspace, empty layout. */
export function freshWorkspaceSlice(): WorkspaceSlice {
  return {
    workspaces: [{ id: 'ws-default', name: 'Default' }],
    activeWorkspace: 'ws-default',
    workspaceData: {},
    groups: [],
    activeGroup: null,
    minimizedIds: [],
  }
}
