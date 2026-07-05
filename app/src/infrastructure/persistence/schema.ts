// Persisted-state schema: version stamp and the selectors that project the
// live AppState into its on-disk partitions (main blob + per-session files).
import type { AppState, MainPartition } from '../../core/types'

/** Bumped when the persisted shape changes in a way hydration must know about.
 *  Hydration stays defensive per-field, so most additions don't require a bump. */
export const SCHEMA_VERSION = 1

/** One session's persisted form: the agent's DURABLE config + output tail
 *  (capped). Runtime-only status (`status`, `escReason`) is dropped — hydration
 *  always restores sessions as idle. Written to its own file (`sessions/<id>.json`). */
export function selectSession(a: AppState['agents'][number]) {
  const { status: _status, escReason: _escReason, ...durable } = a
  void _status; void _escReason
  return { schemaVersion: SCHEMA_VERSION, agent: { ...durable, log: a.log.slice(-200) } }
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
    personas: s.personas,
    skillRegistries: s.skillRegistries,
    chatAgentTypes: s.chatAgentTypes,
    workspaces: s.workspaces,
    activeWorkspace: s.activeWorkspace,
    workspaceData: s.workspaceData,
    groups: s.groups,
    activeGroup: s.activeGroup,
    minimizedIds: s.minimizedIds,
    addons: s.addons,
    addonStorage: s.addonStorage,
    chatMemory: s.chatMemory,
    messages: s.messages.slice(-60),
    events: s.events.slice(0, 60),
    notifications: s.notifications.slice(0, 30),
  }
}
