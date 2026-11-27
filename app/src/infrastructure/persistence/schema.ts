// Persisted-state schema: version stamp and the selectors that project the
// live AppState into its on-disk partitions (main blob + per-session files).
import type { AppState, MainPartition, SessionRecord, WorkspaceData } from '../../core/types'
import { SESSION_RUNTIME_KEYS } from '../../core/types'

/** Bumped when the persisted shape changes in a way hydration must know about.
 *  Hydration stays defensive per-field, so most additions don't require a bump. */
export const SCHEMA_VERSION = 1

/** One session's persisted form: the agent's DURABLE SessionRecord + output tail
 *  (capped). The SessionRuntimeState keys (status, escReason) are dropped —
 *  hydration always restores sessions as idle. Written to `sessions/<id>.json`. */
export function selectSession(a: AppState['agents'][number]) {
  const durable = { ...a } as Partial<Record<keyof typeof a, unknown>>
  for (const k of SESSION_RUNTIME_KEYS) delete durable[k]
  return { schemaVersion: SCHEMA_VERSION, agent: { ...(durable as SessionRecord), log: a.log.slice(-200) } }
}

// Same caps as the active workspace's flat fields. Background workspace slices
// were persisted untrimmed: two of them held 223 and 370 messages and made up
// 1.1 MB of a 1.8 MB file rewritten on every change.
const MESSAGES_KEPT = 60
const EVENTS_KEPT = 60
const NOTIFICATIONS_KEPT = 30
const PENDING_NOTES_KEPT = 16

function trimSlice(d: WorkspaceData): WorkspaceData {
  if (d.messages.length <= MESSAGES_KEPT && d.events.length <= EVENTS_KEPT
    && d.notifications.length <= NOTIFICATIONS_KEPT && (d.pendingMasterNotes ?? []).length <= PENDING_NOTES_KEPT) return d
  return {
    ...d,
    messages: d.messages.slice(-MESSAGES_KEPT),
    events: d.events.slice(0, EVENTS_KEPT),
    notifications: d.notifications.slice(0, NOTIFICATIONS_KEPT),
    pendingMasterNotes: (d.pendingMasterNotes ?? []).slice(-PENDING_NOTES_KEPT),
  }
}

function trimWorkspaceData(data: AppState['workspaceData']): AppState['workspaceData'] {
  const out: AppState['workspaceData'] = {}
  for (const [id, d] of Object.entries(data ?? {})) out[id] = d ? trimSlice(d) : d
  return out
}

/** The low-churn main partition: everything durable except `agents`. */
export function selectMainState(s: AppState): MainPartition {
  return {
    schemaVersion: SCHEMA_VERSION,
    tasks: s.tasks,
    crons: s.crons,
    settings: s.settings,
    toolsCatalog: s.toolsCatalog,
    agentTypes: s.agentTypes,
    templates: s.templates,
    mcpServers: s.mcpServers,
    skills: s.skills,
    skillRegistries: s.skillRegistries,
    chatAgentTypes: s.chatAgentTypes,
    workspaces: s.workspaces,
    activeWorkspace: s.activeWorkspace,
    workspaceData: trimWorkspaceData(s.workspaceData),
    archivedWorkspaces: s.archivedWorkspaces ?? [],
    groups: s.groups,
    activeGroup: s.activeGroup,
    minimizedIds: s.minimizedIds,
    addons: s.addons,
    addonStorage: s.addonStorage,
    chatMemory: s.chatMemory,
    durableAgents: s.durableAgents ?? [],
    assistantMemory: s.assistantMemory ?? {},
    harnessLog: (s.harnessLog ?? []).slice(0, 200),
    messages: s.messages.slice(-MESSAGES_KEPT),
    events: s.events.slice(0, EVENTS_KEPT),
    notifications: s.notifications.slice(0, NOTIFICATIONS_KEPT),
  }
}
