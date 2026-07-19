// Pure change-detectors for the persistence subscriptions. The provider used to
// re-run save effects via React dependency arrays; now it subscribes to the
// store directly and arms the debounced writers only when the slices a writer
// owns actually change. Keeping the comparisons pure makes "did we watch the
// right slices" unit-testable (a missed slice = silent save miss).
import type { AppState } from '../../core/types'
import { secretEntries } from '../../store/secrets'

// The durable slices written to the main partition (everything except agents,
// which live in per-session files). Mirrors selectMainState's inputs — a change
// to any of these should trigger a main-partition save.
const MAIN_SLICES: readonly (keyof AppState)[] = [
  'tasks', 'crons', 'settings', 'toolsCatalog', 'agentTypes', 'templates',
  'mcpServers', 'skills', 'skillRegistries', 'chatAgentTypes',
  'groups', 'activeGroup', 'minimizedIds', 'addons', 'addonStorage',
  'chatMemory', 'durableAgents', 'assistantMemory', 'harnessLog',
  'messages', 'events', 'notifications', 'workspaces', 'activeWorkspace', 'workspaceData',
  'archivedWorkspaces',
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

/** True only when a keychain account/value changes. Credential-bearing records
 *  also contain runtime metadata (for example MCP tool counts); comparing their
 *  array identities caused that metadata to rewrite every secret in Keychain. */
export function secretsChanged(a: AppState, b: AppState): boolean {
  if (a.settings === b.settings && a.chatAgentTypes === b.chatAgentTypes && a.mcpServers === b.mcpServers) return false
  const before = new Map(secretEntries(a).map(e => [e.account, e.value]))
  const after = new Map(secretEntries(b).map(e => [e.account, e.value]))
  if (before.size !== after.size) return true
  for (const [account, value] of before) {
    if (!after.has(account) || after.get(account) !== value) return true
  }
  return false
}

/** True when a chat search document changed (a chat was added/removed, its
 *  transcript changed, or its indexed name/tags changed). Terminal output and
 *  unrelated chat fields must NOT trigger a search reindex. */
export function chatTranscriptsChanged(a: AppState, b: AppState): boolean {
  const prev = new Map<string, { log: unknown; name: string; tags: unknown }>()
  let prevCount = 0
  for (const x of a.agents) {
    if (x.kind !== 'chat') continue
    prev.set(x.id, { log: x.chatLog, name: x.name, tags: x.chatTags })
    prevCount++
  }
  let count = 0
  for (const x of b.agents) {
    if (x.kind !== 'chat') continue
    count++
    const old = prev.get(x.id)
    if (!old || old.log !== x.chatLog || old.name !== x.name || old.tags !== x.chatTags) return true
  }
  return count !== prevCount
}
