// Minimal MCP client over streamable HTTP: JSON-RPC POSTs to the server URL,
// accepting plain-JSON and SSE-framed responses. Covers what chat agents
// need — initialize, tools/list, tools/call — with per-server headers.
import { httpPostText } from './native'

export interface McpToolDef {
  name: string
  description: string
  /** JSON schema of the tool arguments */
  inputSchema: Record<string, unknown>
}

export interface McpSession {
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

/** One JSON-RPC call (or fire-and-forget notification when method starts with "notifications/"). */
async function rpc(s: Pick<McpSession, 'url' | 'headers' | 'sessionId'>, method: string, params?: unknown): Promise<unknown> {
  const isNotification = method.startsWith('notifications/')
  const id = ++rpcId
  const body = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}), ...(isNotification ? {} : { id }) })
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

/** Connect to a streamable-HTTP MCP server: initialize + list its tools. */
export async function mcpConnect(serverName: string, url: string, headerLines?: string): Promise<McpSession> {
  const headers = parseHeaderLines(headerLines)
  const id = ++rpcId
  const initBody = JSON.stringify({
    jsonrpc: '2.0', id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'yaam', version: '1.0' },
    },
  })
  const { text, contentType, mcpSessionId } = await httpPostText(url, initBody, {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  })
  const init = parseRpcBody(text, contentType, id)
  if (!init) throw new Error('server sent no initialize response')
  if (init.error) throw new Error(init.error.message || 'initialize failed')
  const session: McpSession = { url, headers, sessionId: mcpSessionId, tools: [], serverName }
  await rpc(session, 'notifications/initialized').catch(() => { /* some servers reject notifications; not fatal */ })
  const listed = await rpc(session, 'tools/list') as { tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }
  session.tools = (listed?.tools ?? []).map(t => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }))
  return session
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
