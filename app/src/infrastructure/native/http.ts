// HTTP adapter: routes requests through Tauri's HTTP plugin (reqwest) on desktop
// so they aren't blocked by CORS, and through the browser fetch otherwise.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from './base'
import { debugLog } from '../../core/debug-log'

// Tauri's HTTP plugin (reqwest) sends NO default User-Agent, and some APIs —
// notably api.github.com — reject UA-less requests with 403. Browsers set
// their own UA (and forbid overriding it), so only add ours on the desktop.
const UA_HEADER: Record<string, string> = isTauri ? { 'user-agent': 'yaam/1.0' } : {}

// GitHub personal access token (Settings → General). Injected ONLY into GET
// fetches against GitHub hosts — skill registries, plugin marketplaces, MCP
// catalogs — lifting the 60 req/h unauthenticated rate limit. Deliberately
// NOT injected into httpRequest: that is the chat agent's generic tool, and
// the model must not silently act on GitHub with the user's credentials.
let githubToken: () => string = () => ''

/** Wire where the GitHub token is read from (called once at boot). */
export function setGithubTokenSource(fn: () => string): void {
  githubToken = fn
}

function githubAuth(url: string): Record<string, string> {
  if (!/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com|codeload\.github\.com|github\.com)\//.test(url)) return {}
  const t = githubToken().trim()
  return t ? { authorization: `Bearer ${t}` } : {}
}

/** One debug-log line for a failed GitHub/registry fetch, with enough context
 *  to self-diagnose the two classic breakages: a stale saved token (401/403
 *  even on raw.githubusercontent) and the 60 req/h anonymous rate limit. */
function logHttpFailure(method: string, url: string, res?: Response, err?: unknown) {
  if (!res) {
    debugLog('http', `${method} ${url} → ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const remaining = res.headers.get('x-ratelimit-remaining')
  const tokenUsed = 'authorization' in githubAuth(url)
  const hint = (res.status === 401 || res.status === 403)
    ? tokenUsed
      ? ' (sent the saved GitHub token — if this keeps happening the token is likely expired/revoked: Settings → General)'
      : remaining === '0' ? ' (GitHub anonymous rate limit exhausted — add a token in Settings → General)' : ''
    : ''
  debugLog('http', `${method} ${url} → HTTP ${res.status}${remaining !== null ? ` · ratelimit-remaining ${remaining}` : ''}${hint}`)
}

/** Fetch text through Tauri's HTTP plugin so desktop requests are not blocked by CORS. */
export async function httpGetText(url: string): Promise<string> {
  let res: Response
  try {
    res = await (isTauri ? tauriFetch : fetch)(url, { headers: { ...UA_HEADER, ...githubAuth(url) } })
  } catch (err) {
    logHttpFailure('GET', url, undefined, err)
    throw err
  }
  if (!res.ok) {
    logHttpFailure('GET', url, res)
    throw new Error(`HTTP ${res.status}`)
  }
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
export async function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  redirect: RequestRedirect = 'follow',
): Promise<{ status: number; text: string; contentType: string }> {
  const m = method.toUpperCase()
  const res = await (isTauri ? tauriFetch : fetch)(url, {
    method: m,
    headers: { ...UA_HEADER, ...headers },
    redirect,
    ...(body !== undefined && m !== 'GET' && m !== 'HEAD' ? { body } : {}),
  })
  const text = await res.text()
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? '' }
}
