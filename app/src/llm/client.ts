// LLM providers and protocol adapters (Anthropic Messages / OpenAI-compatible
// chat completions). HTTP goes through the Tauri backend to avoid CORS.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { bedrockInvoke, isTauri, runCredentialCommand } from '../native'
import type { AppState } from '../types'

/** Select Tauri HTTP on desktop and the browser fetch implementation in web previews. */
const doFetch: typeof fetch = (...args) => (isTauri ? tauriFetch(...args) : fetch(...args))

export interface ProviderDef {
  id: string
  label: string
  base: string
  protocol: 'anthropic' | 'openai'
  models: string[]
  keyHint: string
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', base: 'https://api.anthropic.com', protocol: 'anthropic', models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'], keyHint: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], keyHint: 'sk-…' },
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com', protocol: 'openai', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: 'sk-…' },
  { id: 'kimi', label: 'Kimi (Moonshot)', base: 'https://api.moonshot.ai/v1', protocol: 'openai', models: ['kimi-k2-0905-preview', 'kimi-latest'], keyHint: 'sk-…' },
  { id: 'gemini', label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyHint: 'AIza…' },
  { id: 'glm', label: 'GLM (Z.ai / Zhipu)', base: 'https://api.z.ai/api/paas/v4', protocol: 'openai', models: ['glm-4.6', 'glm-4.5-air'], keyHint: 'api key' },
  { id: 'bedrock', label: 'AWS Bedrock (Claude)', base: '', protocol: 'anthropic', models: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'], keyHint: 'no key — AWS credential chain' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', base: '', protocol: 'openai', models: [], keyHint: 'api key' },
  { id: 'anthropic-compat', label: 'Custom (Anthropic-compatible)', base: '', protocol: 'anthropic', models: [], keyHint: 'api key' },
]

/** Resolve a provider id, falling back to the first supported provider. */
export function providerFor(id: string): ProviderDef {
  return PROVIDERS.find(pr => pr.id === id) ?? PROVIDERS[0]
}

export interface ApiContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ApiResponse {
  content: ApiContentBlock[]
  stop_reason: string
  error?: { message: string }
}

export type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

export interface LlmConfig {
  provider: ProviderDef
  baseUrl: string
  apiKey: string
  model: string
  awsRegion: string
  awsProfile: string
  awsRefreshCmd: string
  credCmd: string
}

// ---------------------------------------------------------------- credential command
// A configured credential command (e.g. `claude default-credential-export`)
// prints the API credential — a raw key/token, or JSON. The result is cached
// until its own expiry (when the JSON declares one) or a short TTL, and the
// cache is dropped + the command re-run when the API rejects the credential.

const CRED_TTL_MS = 15 * 60 * 1000
let credCache: { cmd: string; key: string; exp: number } | null = null

/** Dig a credential + optional expiry out of command output. */
function parseCredOutput(raw: string): { key: string; exp: number } {
  let exp = Date.now() + CRED_TTL_MS
  const text = raw.trim()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // not JSON — treat the last non-empty output line as the credential
    const key = text.split('\n').filter(l => l.trim()).pop()?.trim() ?? ''
    if (!key) throw new Error('credential command printed nothing')
    return { key, exp }
  }
  if (json.AccessKeyId || json.accessKeyId || json.Credentials || json.credentials) {
    throw new Error('credential command printed AWS credentials — switch the provider to AWS Bedrock to use them')
  }
  // Claude Code credential file shape: { claudeAiOauth: { accessToken, expiresAt } }
  const oauth = json.claudeAiOauth as Record<string, unknown> | undefined
  const nested = oauth ?? json
  const key = ['accessToken', 'access_token', 'apiKey', 'api_key', 'token', 'key', 'credential', 'value']
    .map(k => nested[k] ?? json[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  if (!key) throw new Error('credential command printed JSON without a recognizable key/token field')
  const expiresAt = nested.expiresAt ?? json.expiresAt ?? nested.expires_at ?? json.expires_at
  if (typeof expiresAt === 'number') exp = Math.min(exp, expiresAt - 60_000)
  else if (typeof expiresAt === 'string') {
    const t = Date.parse(expiresAt)
    if (!Number.isNaN(t)) exp = Math.min(exp, t - 60_000)
  }
  return { key, exp }
}

/** The credential to send: from the command (cached) or the static API key. */
async function resolveKey(cfg: LlmConfig, forceRefresh = false): Promise<string> {
  const cmd = cfg.credCmd.trim()
  if (!cmd) return cfg.apiKey
  if (!forceRefresh && credCache && credCache.cmd === cmd && Date.now() < credCache.exp) {
    return credCache.key
  }
  const parsed = parseCredOutput(await runCredentialCommand(cmd))
  credCache = { cmd, key: parsed.key, exp: parsed.exp }
  return parsed.key
}

/** Claude Code OAuth tokens authenticate as Bearer, not x-api-key. */
function anthropicAuthHeaders(key: string): Record<string, string> {
  if (key.startsWith('sk-ant-oat')) {
    return { authorization: `Bearer ${key}`, 'anthropic-beta': 'oauth-2025-04-20' }
  }
  return { 'x-api-key': key }
}

/** Send one Anthropic-shaped request through direct HTTP or the Bedrock bridge. */
async function callAnthropic(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  if (cfg.provider.id === 'bedrock') {
    // model id goes in the URL on Bedrock; auth is SigV4 in the backend
    const body = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 2048, temperature: 0.2, system, messages, tools })
    const raw = await bedrockInvoke(cfg.awsRegion || 'us-east-1', cfg.awsProfile, cfg.awsRefreshCmd, cfg.credCmd, cfg.model, body)
    return JSON.parse(raw) as ApiResponse
  }
  // Build the request with a supplied key so auth failures can refresh and retry once.
  const anthropicBase = (cfg.provider.id === 'anthropic-compat' ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  const send = async (key: string) => doFetch(`${anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...anthropicAuthHeaders(key),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.2, system, messages, tools }),
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    // stale credential — re-run the credential command and retry once
    res = await send(await resolveKey(cfg, true))
  }
  const data = await res.json() as ApiResponse
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  return data
}

interface OaiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OaiMessage {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: OaiToolCall[]
  tool_call_id?: string
}

/** Convert internal (Anthropic-shaped) history to OpenAI chat format. */
function toOpenAiMessages(system: string, messages: ApiMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = m.content as ApiContentBlock[]
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id || '', type: 'function' as const,
        function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) },
      }))
      out.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    } else {
      // tool results
      for (const b of blocks as Array<{ type: string; tool_use_id?: string; content?: string }>) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content ?? '' })
      }
    }
  }
  return out
}

/** Adapt one request to OpenAI chat completions and normalize its response. */
async function callOpenAi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  const base = (cfg.provider.models.length === 0 && cfg.baseUrl ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  if (!base) throw new Error('custom provider needs a base URL (Settings → Master Brain)')
  // Build the request with a supplied key so auth failures can refresh and retry once.
  const send = async (key: string) => doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      temperature: 0.2,
      messages: toOpenAiMessages(system, messages),
      tools: (tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    // stale credential — re-run the credential command and retry once
    res = await send(await resolveKey(cfg, true))
  }
  const data = await res.json() as {
    choices?: Array<{ message: OaiMessage; finish_reason: string }>
    error?: { message: string }
  }
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  const msg = data.choices?.[0]?.message
  const content: ApiContentBlock[] = []
  if (msg?.reasoning_content) content.push({ type: 'thinking', text: msg.reasoning_content })
  if (msg?.content) content.push({ type: 'text', text: msg.content })
  for (const tc of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(tc.function.arguments || '{}') } catch { /* malformed args */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
  }
  return { content, stop_reason: msg?.tool_calls?.length ? 'tool_use' : 'end_turn' }
}

/** Route a normalized LLM request to the configured wire-protocol adapter. */
export function callApi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  return cfg.provider.protocol === 'anthropic' ? callAnthropic(cfg, system, messages, tools) : callOpenAi(cfg, system, messages, tools)
}

/** Whether the settings hold usable credentials for the chosen provider.
 *  Bedrock has no API key — it authenticates via the AWS credential chain. */
export function hasCreds(settings: AppState['settings']): boolean {
  return settings.provider === 'bedrock' || Boolean(settings.apiKey) || Boolean(settings.credCmd.trim())
}

/** Config for a chat-agent type: its own provider/key/base, falling back to
 *  the Master Brain credentials when it shares the provider and sets no key. */
export function buildChatCfg(
  t: { provider: string; model: string; apiKey?: string; baseUrl?: string },
  settings: AppState['settings'],
): LlmConfig {
  const shared = t.provider === settings.provider && !t.apiKey
  return {
    provider: providerFor(t.provider),
    baseUrl: t.baseUrl || (shared ? settings.baseUrl : ''),
    apiKey: t.apiKey || (shared ? settings.apiKey : ''),
    model: t.model,
    awsRegion: settings.awsRegion,
    awsProfile: settings.awsProfile,
    awsRefreshCmd: settings.awsRefreshCmd,
    credCmd: shared ? settings.credCmd : '',
  }
}

/** True when a chat-agent type can authenticate (own key, Bedrock chain, or shared Master creds). */
export function chatTypeHasCreds(
  t: { provider: string; apiKey?: string },
  settings: AppState['settings'],
): boolean {
  if (t.provider === 'bedrock') return true
  if (t.apiKey) return true
  return t.provider === settings.provider && (Boolean(settings.apiKey) || Boolean(settings.credCmd.trim()))
}

/** Project persisted orchestration settings into the provider-neutral client config. */
export function buildCfg(settings: AppState['settings'], modelOverride?: string): LlmConfig {
  return {
    provider: providerFor(settings.provider),
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: modelOverride || settings.masterModel,
    awsRegion: settings.awsRegion,
    awsProfile: settings.awsProfile,
    awsRefreshCmd: settings.awsRefreshCmd,
    credCmd: settings.credCmd,
  }
}
