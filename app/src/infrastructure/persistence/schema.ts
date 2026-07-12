// Persisted-state schema: version stamp and the selectors that project the
// live AppState into its on-disk partitions (main blob + per-session files).
import type { AppState, MainPartition, SessionRecord } from '../../core/types'
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
    workspaceData: s.workspaceData,
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
    messages: s.messages.slice(-60),
    events: s.events.slice(0, 60),
    notifications: s.notifications.slice(0, 30),
  }
}
