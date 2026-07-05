// Pure change-detectors for the persistence subscriptions. The provider used to
// re-run save effects via React dependency arrays; now it subscribes to the
// store directly and arms the debounced writers only when the slices a writer
// owns actually change. Keeping the comparisons pure makes "did we watch the
// right slices" unit-testable (a missed slice = silent save miss).
import type { AppState } from '../../core/types'

// The durable slices written to the main partition (everything except agents,
// which live in per-session files). Mirrors selectMainState's inputs — a change
// to any of these should trigger a main-partition save.
const MAIN_SLICES: readonly (keyof AppState)[] = [
  'tasks', 'crons', 'settings', 'toolsCatalog', 'agentTypes', 'templates',
  'mcpServers', 'skills', 'personas', 'skillRegistries', 'chatAgentTypes',
  'groups', 'activeGroup', 'minimizedIds', 'addons', 'addonStorage',
  'messages', 'events', 'notifications', 'workspaces', 'activeWorkspace', 'workspaceData',
]

/** True when any durable main-partition slice changed reference. */
export function mainPartitionChanged(a: AppState, b: AppState): boolean {
  return MAIN_SLICES.some(k => a[k] !== b[k])
}

/** True when the per-session set changed (agents are updated immutably, so a
 *  changed array reference means at least one session record changed). */
export function sessionsChanged(a: AppState, b: AppState): boolean {
  return a.agents !== b.agents
}

/** True when a credential-bearing slice changed (API key, chat agent types, or
 *  MCP servers) — the only inputs the keychain mirror cares about. */
export function secretsChanged(a: AppState, b: AppState): boolean {
  return a.settings.apiKey !== b.settings.apiKey
    || a.chatAgentTypes !== b.chatAgentTypes
    || a.mcpServers !== b.mcpServers
}

/** True when a chat session's transcript changed (a chat agent was added/removed
 *  or its chatLog reference changed). Terminal output and status updates on
 *  non-chat sessions — or non-chatLog fields of a chat — must NOT trigger a
 *  search reindex. */
export function chatTranscriptsChanged(a: AppState, b: AppState): boolean {
  const prev = new Map<string, unknown>()
  let prevCount = 0
  for (const x of a.agents) {
    if (x.kind !== 'chat') continue
    prev.set(x.id, x.chatLog)
    prevCount++
  }
  let count = 0
  for (const x of b.agents) {
    if (x.kind !== 'chat') continue
    count++
    if (!prev.has(x.id) || prev.get(x.id) !== x.chatLog) return true
  }
  return count !== prevCount
}
