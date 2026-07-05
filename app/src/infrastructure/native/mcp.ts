// stdio MCP transport adapter: the backend owns the child process; we exchange
// newline-delimited JSON-RPC strings with it. Requires the desktop app.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export async function mcpStdioStart(id: string, command: string, args: string[], env: Record<string, string>, cwd?: string): Promise<void> {
  if (!isTauri) throw new Error('stdio MCP servers require the desktop app')
  await invoke('mcp_stdio_start', { id, command, args, env, cwd: cwd || null })
}

export async function mcpStdioRequest(id: string, payload: string, timeoutMs?: number): Promise<string> {
  if (!isTauri) throw new Error('stdio MCP servers require the desktop app')
  return await invoke<string>('mcp_stdio_request', { id, payload, timeoutMs: timeoutMs ?? null })
}

export async function mcpStdioNotify(id: string, payload: string): Promise<void> {
  if (!isTauri) return
  await invoke('mcp_stdio_notify', { id, payload })
}

export async function mcpStdioStop(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('mcp_stdio_stop', { id })
}
