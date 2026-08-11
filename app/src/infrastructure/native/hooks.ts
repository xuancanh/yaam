// Native bridge for the local agent-hook listener: Claude Code sessions POST
// lifecycle hook events (tool use, permission prompts, turn end) to the Rust
// HTTP listener, which forwards them here as `agent-hook` Tauri events.
// Browser build: no listener, no events.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './base'

export interface HookListenerInfo {
  port: number
  token: string
}

/** A forwarded hook POST: `agent` is YAAM's session id (embedded in the hook
 *  URL at launch), `payload` the CLI's raw hook JSON. */
export interface AgentHookEvent {
  agent: string | null
  payload: Record<string, unknown>
}

/** Address + bearer token of the hook listener, starting it on first use.
 *  Null outside the desktop app or when the listener cannot bind. */
export async function hooksInfo(): Promise<HookListenerInfo | null> {
  if (!isTauri) return null
  try {
    return await invoke<HookListenerInfo>('hooks_info')
  } catch {
    return null
  }
}

/** Subscribe to forwarded hook events; returns an unsubscribe function. */
export function onAgentHook(cb: (e: AgentHookEvent) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<AgentHookEvent>('agent-hook', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}
