// HTTP adapter: routes requests through Tauri's HTTP plugin (reqwest) on desktop
// so they aren't blocked by CORS, and through the browser fetch otherwise.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from './base'

// Tauri's HTTP plugin (reqwest) sends NO default User-Agent, and some APIs —
// notably api.github.com — reject UA-less requests with 403. Browsers set
// their own UA (and forbid overriding it), so only add ours on the desktop.
const UA_HEADER: Record<string, string> = isTauri ? { 'user-agent': 'yaam/1.0' } : {}

/** Fetch text through Tauri's HTTP plugin so desktop requests are not blocked by CORS. */
export async function httpGetText(url: string): Promise<string> {
  const res = await (isTauri ? tauriFetch : fetch)(url, { headers: UA_HEADER })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/** POST text (JSON-RPC etc.) through Tauri's HTTP plugin; returns body + headers of interest. */
export async function httpPostText(url: string, body: string, headers: Record<string, string>): Promise<{ text: string; contentType: string; mcpSessionId: string | null }> {
  const res = await (isTauri ? tauriFetch : fetch)(url, { method: 'POST', headers: { ...UA_HEADER, ...headers }, body })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  return { text, contentType: res.headers.get('content-type') ?? '', mcpSessionId: res.headers.get('mcp-session-id') }
}

/** Generic HTTP request through Tauri's plugin (CORS-free on desktop); returns
 *  status + body so tool callers can surface API errors to the model. */
export async function httpRequest(method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; contentType: string }> {
  const m = method.toUpperCase()
  const res = await (isTauri ? tauriFetch : fetch)(url, {
    method: m,
    headers: { ...UA_HEADER, ...headers },
    ...(body !== undefined && m !== 'GET' && m !== 'HEAD' ? { body } : {}),
  })
  const text = await res.text()
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' }
}
