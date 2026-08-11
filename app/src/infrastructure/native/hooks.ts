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

/** Write (or refresh) the global Kiro hook bridge so kiro-cli sessions forward
 *  their lifecycle events to the listener. Best-effort. */
export async function kiroHooksInstall(url: string): Promise<void> {
  if (!isTauri) return
  await invoke('kiro_hooks_install', { url }).catch(() => {})
}

/** One MCP tools/call from a spawned session, awaiting an answer. */
export interface McpServeCall {
  callId: number
  /** YAAM session id from the per-session server URL */
  agent: string | null
  name: string | null
  arguments: Record<string, unknown>
}

/** Complete one pending tools/call with an MCP tool result. */
export async function mcpServeRespond(callId: number, result: Record<string, unknown>): Promise<void> {
  if (!isTauri) return
  await invoke('mcp_serve_respond', { callId, result }).catch(() => {})
}

/** Subscribe to manager-tool calls from sessions; returns an unsubscribe fn. */
export function onMcpServeCall(cb: (e: McpServeCall) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<McpServeCall>('mcp-serve-call', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
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
