// Minimal MCP client over two transports: streamable HTTP (JSON-RPC POSTs,
// accepting plain-JSON and SSE-framed responses) and stdio (a local server
// process owned by the Rust backend). Covers what chat agents need —
// initialize, tools/list, tools/call — with per-server headers/env.
import { httpPostText, mcpStdioNotify, mcpStdioRequest, mcpStdioStart, mcpStdioStop } from './native'
import type { McpServer } from './types'

export interface McpToolDef {
  name: string
  description: string
  /** JSON schema of the tool arguments */
  inputSchema: Record<string, unknown>
}

export interface McpSession {
  transport: 'http' | 'stdio'
  /** server id — the stdio process key in the backend */
  serverId: string
  url: string
  headers: Record<string, string>
  sessionId: string | null
  tools: McpToolDef[]
  serverName: string
}

/** "KEY: value" lines → header map. */
export function parseHeaderLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** "KEY=value" lines → env map. */
export function parseEnvLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

interface RpcResponse {
  result?: unknown
  error?: { code?: number; message?: string }
  id?: unknown
}

/** Extract the JSON-RPC response from a plain-JSON or SSE body. */
function parseRpcBody(text: string, contentType: string, id: number): RpcResponse | null {
  if (contentType.includes('text/event-stream')) {
    // take the last data: event carrying our response id (servers may stream
    // notifications first)
    let found: RpcResponse | null = null
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      try {
        const msg = JSON.parse(line.slice(5).trim()) as RpcResponse
        if (msg && (msg.result !== undefined || msg.error) && (msg.id === id || msg.id === String(id))) found = msg
      } catch { /* keep-scanning: partial or non-JSON SSE line */ }
    }
    return found
  }
  if (!text.trim()) return null
  return JSON.parse(text) as RpcResponse
}

let rpcId = 0

/** One JSON-RPC call (or fire-and-forget notification when method starts with
 *  "notifications/") over the session's transport. */
async function rpc(s: Pick<McpSession, 'transport' | 'serverId' | 'url' | 'headers' | 'sessionId'>, method: string, params?: unknown): Promise<unknown> {
  const isNotification = method.startsWith('notifications/')
  const id = ++rpcId
  const body = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(isNotification ? {} : { id }) })
  if (s.transport === 'stdio') {
    if (isNotification) { await mcpStdioNotify(s.serverId, body); return undefined }
    const line = await mcpStdioRequest(s.serverId, body, 60_000)
    const res = JSON.parse(line) as RpcResponse
    if (res.error) throw new Error(res.error.message || `MCP error ${res.error.code}`)
    return res.result
  }
  const { text, contentType } = await httpPostText(s.url, body, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(s.sessionId ? { 'mcp-session-id': s.sessionId } : {}),
    ...s.headers,
  })
  if (isNotification) return undefined
  const res = parseRpcBody(text, contentType, id)
  if (!res) throw new Error(`no JSON-RPC response for ${method}`)
  if (res.error) throw new Error(res.error.message || `MCP error ${res.error.code}`)
  return res.result
}

const INIT_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'yaam', version: '1.0' },
}

/** After initialize: announce readiness and pull the tool list. */
async function finishConnect(session: McpSession): Promise<McpSession> {
  await rpc(session, 'notifications/initialized').catch(() => { /* some servers reject notifications; not fatal */ })
  const listed = await rpc(session, 'tools/list') as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }
  session.tools = (listed?.tools ?? []).map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }))
  return session
}

/** Connect one configured MCP server (http or stdio): initialize + list tools. */
export async function mcpConnect(server: Pick<McpServer, 'id' | 'name' | 'url' | 'headers' | 'transport' | 'command' | 'args' | 'env' | 'cwd'>): Promise<McpSession> {
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) throw new Error('stdio server needs a command')
    await mcpStdioStart(server.id, server.command.trim(), server.args ?? [], parseEnvLines(server.env), server.cwd)
    const session: McpSession = { transport: 'stdio', serverId: server.id, url: '', headers: {}, sessionId: null, tools: [], serverName: server.name }
    const init = await rpc(session, 'initialize', INIT_PARAMS).catch(async e => {
      await mcpStdioStop(server.id).catch(() => {})
      throw e
    })
    if (init === undefined) throw new Error('server sent no initialize response')
    return await finishConnect(session)
  }
  const headers = parseHeaderLines(server.headers)
  const id = ++rpcId
  const initBody = JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: INIT_PARAMS })
  const { text, contentType, mcpSessionId } = await httpPostText(server.url, initBody, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  })
  const init = parseRpcBody(text, contentType, id)
  if (!init) throw new Error('server sent no initialize response')
  if (init.error) throw new Error(init.error.message || 'initialize failed')
  const session: McpSession = { transport: 'http', serverId: server.id, url: server.url, headers, sessionId: mcpSessionId, tools: [], serverName: server.name }
  return await finishConnect(session)
}

/** Tear a session down (stops the stdio process; http sessions just drop). */
export async function mcpDisconnect(session: McpSession): Promise<void> {
  if (session.transport === 'stdio') await mcpStdioStop(session.serverId).catch(() => {})
}

/** Call one MCP tool; flattens the content blocks into text for the LLM. */
export async function mcpCallTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await rpc(session, 'tools/call', { name, arguments: args }) as {
    content?: { type: string; text?: string; data?: string; mimeType?: string }[]
    isError?: boolean
  }
  const text = (res?.content ?? [])
    .map(c => c.type === 'text' ? (c.text ?? '') : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`)
    .filter(Boolean)
    .join('\n')
  return res?.isError ? `tool error: ${text || 'unknown error'}` : (text || '(empty result)')
}
