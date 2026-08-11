// Native bridge for the OpenCode server event client: YAAM pins each spawned
// OpenCode TUI's local HTTP server to a known port and the Rust side streams
// its SSE event bus back as `opencode-event`s. Browser build: no-ops.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './base'

/** A forwarded server-bus event: `agent` is YAAM's session id, `payload` the
 *  server's raw event JSON ({type, properties}). */
export interface OpencodeEvent {
  agent: string
  payload: Record<string, unknown>
}

/** An OS-assigned loopback port, released for the CLI to bind at launch. */
export async function freePort(): Promise<number | null> {
  if (!isTauri) return null
  try {
    return await invoke<number>('free_port')
  } catch {
    return null
  }
}

/** Start (or replace) the event watcher for a session's OpenCode server. */
export async function opencodeWatch(agent: string, port: number): Promise<void> {
  if (!isTauri) return
  await invoke('opencode_watch', { agent, port }).catch(() => {})
}

/** Stop a session's OpenCode event watcher. */
export async function opencodeUnwatch(agent: string): Promise<void> {
  if (!isTauri) return
  await invoke('opencode_unwatch', { agent }).catch(() => {})
}

/** Subscribe to forwarded server events; returns an unsubscribe function. */
export function onOpencodeEvent(cb: (e: OpencodeEvent) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<OpencodeEvent>('opencode-event', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}
