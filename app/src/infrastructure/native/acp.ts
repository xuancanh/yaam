// Native bridge for ACP (Agent Client Protocol) sessions: the Rust peer
// spawns the agent over stdio, runs the handshake, and forwards protocol
// traffic as `acp-event`s. Browser build: no-ops.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './base'

/** One forwarded protocol event for a session. */
export interface AcpEvent {
  agent: string
  kind: 'ready' | 'update' | 'permission' | 'response' | 'error'
  sessionId?: string
  requestId?: unknown
  id?: number
  params?: Record<string, unknown>
  result?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  stage?: string
}

/** Spawn an ACP agent for a session and run the handshake. */
export async function acpStart(agent: string, command: string, cwd: string, shell?: string): Promise<void> {
  if (!isTauri) throw new Error('ACP sessions require the desktop app')
  await invoke('acp_start', { agent, command, cwd, shell: shell || null })
}

/** Send one prompt turn (updates stream back as events). */
export async function acpPrompt(agent: string, text: string): Promise<void> {
  if (!isTauri) return
  await invoke('acp_prompt', { agent, text }).catch(() => {})
}

/** Cancel the in-flight turn. */
export async function acpCancel(agent: string): Promise<void> {
  if (!isTauri) return
  await invoke('acp_cancel', { agent }).catch(() => {})
}

/** Answer a pending permission request; omit optionId to respond cancelled. */
export async function acpRespondPermission(agent: string, requestId: unknown, optionId?: string): Promise<void> {
  if (!isTauri) return
  await invoke('acp_respond_permission', { agent, requestId, optionId: optionId ?? null }).catch(() => {})
}

/** Kill the agent process and forget the session. */
export async function acpStop(agent: string): Promise<void> {
  if (!isTauri) return
  await invoke('acp_stop', { agent }).catch(() => {})
}

/** Subscribe to forwarded protocol events; returns an unsubscribe function. */
export function onAcpEvent(cb: (e: AcpEvent) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<AcpEvent>('acp-event', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}
