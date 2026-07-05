// Persistence adapter: durable partition + per-session file writes (serialized
// per partition to avoid temp-file races), with a localStorage fallback in the
// browser build. Backup recovery reads the previous main snapshot.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

// Serialize state writes per partition: a debounced save and a teardown flush
// can otherwise hit the backend concurrently and race on the temp file.
// Chaining guarantees one write finishes before the next starts, and coalescing
// to the latest queued payload keeps a burst from piling up stale saves. Each
// partition (main state, sessions, …) has its own independent chain.
const saveChains = new Map<string, { chain: Promise<void>; queued: string | null }>()

/** Persist one state partition through the backend, serialized per partition. */
function savePartitionSerialized(partition: string, invokeName: string, args: (json: string) => Record<string, unknown>, json: string): Promise<void> {
  const entry = saveChains.get(partition) ?? { chain: Promise.resolve(), queued: null }
  entry.queued = json
  entry.chain = entry.chain.then(async () => {
    if (entry.queued === null) return // superseded by an earlier link
    const payload = entry.queued
    entry.queued = null
    await invoke(invokeName, args(payload))
  })
  saveChains.set(partition, entry)
  return entry.chain
}

/** Persist the main app-state partition, with localStorage fallback.
 *  Rejects on failure so callers can surface the error. */
export function saveStateFile(json: string): Promise<void> {
  if (!isTauri) { localStorage.setItem('conductor-state', json); return Promise.resolve() }
  return savePartitionSerialized('conductor-state', 'save_state', j => ({ json: j }), json)
}

/** Load the main app-state partition, with localStorage fallback. */
export async function loadStateFile(): Promise<string | null> {
  if (!isTauri) return localStorage.getItem('conductor-state')
  return await invoke<string | null>('load_state')
}

/** Load the previous main snapshot (the .bak) — recover when the primary
 *  file is present but unparseable. */
export async function loadStateBackup(): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('load_state_backup')
}

/** Persist a named high-churn partition (e.g. `sessions`), with localStorage
 *  fallback. Serialized per partition. */
export function savePartition(name: string, json: string): Promise<void> {
  if (!isTauri) { localStorage.setItem(`conductor-${name}`, json); return Promise.resolve() }
  return savePartitionSerialized(name, 'save_partition', j => ({ name, json: j }), json)
}

/** Load a named partition, with localStorage fallback. */
export async function loadPartition(name: string): Promise<string | null> {
  if (!isTauri) return localStorage.getItem(`conductor-${name}`)
  return await invoke<string | null>('load_partition', { name })
}

/** Persist one session (agent) to its own file, serialized per session id.
 *  One file per session keeps a terminal line / chat token from rewriting a
 *  monolithic all-sessions blob. */
export function saveSession(id: string, json: string): Promise<void> {
  if (!isTauri) { localStorage.setItem(`conductor-session-${id}`, json); return Promise.resolve() }
  return savePartitionSerialized(`session:${id}`, 'save_session', j => ({ id, json: j }), json)
}

/** Delete one session's file. */
export async function removeSession(id: string): Promise<void> {
  if (!isTauri) { localStorage.removeItem(`conductor-session-${id}`); return }
  await invoke('remove_session', { id })
}

/** Load every persisted session file (each element is one session's JSON). */
export async function loadSessions(): Promise<string[]> {
  if (!isTauri) {
    return Object.keys(localStorage)
      .filter(k => k.startsWith('conductor-session-'))
      .map(k => localStorage.getItem(k))
      .filter((s): s is string => s !== null)
  }
  return await invoke<string[]>('load_sessions')
}
