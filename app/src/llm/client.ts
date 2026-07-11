// LLM providers and protocol adapters (Anthropic Messages / OpenAI-compatible
// chat completions). HTTP goes through the Tauri backend to avoid CORS.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { bedrockInvoke, isTauri, runCredentialCommand } from '../core/native'
import type { AppState } from '../core/types'

/** Select Tauri HTTP on desktop and the browser fetch implementation in web previews. */
const doFetch: typeof fetch = (...args) => (isTauri ? tauriFetch(...args) : fetch(...args))
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

async function readTextBounded(res: Response, cap = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`API response exceeds the ${cap} byte limit`)
  }
  if (!res.body) {
    const text = await res.text()
    if (text.length > cap) throw new Error(`API response exceeds the ${cap} byte limit`)
    return text
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > cap) {
      await reader.cancel().catch(() => {})
      throw new Error(`API response exceeds the ${cap} byte limit`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

async function readJsonBounded<T>(res: Response, cap = MAX_RESPONSE_BYTES): Promise<T> {
  return JSON.parse(await readTextBounded(res, cap)) as T
}

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

// ---------------------------------------------------------------- extended thinking

export type ThinkingEffort = 'low' | 'medium' | 'high'

/** Anthropic thinking budgets per effort (min allowed is 1024). */
export const THINKING_BUDGETS: Record<ThinkingEffort, number> = { low: 2048, medium: 8192, high: 16384 }

/** Whether a provider+model pair accepts a thinking/effort request parameter.
 *  Conservative: unknown models get no parameter rather than a 400. */
export function supportsThinking(providerId: string, model: string): boolean {
  const m = model.toLowerCase()
  switch (providerId) {
    case 'anthropic':
    case 'anthropic-compat':
    case 'bedrock':
      // extended thinking landed with the 3.7/4.x generations
      return /claude/.test(m) && !/claude-3-[05]/.test(m)
    case 'openai':
      return /^(o\d|gpt-5)/.test(m)
    case 'gemini':
      return /^gemini-[23]/.test(m)
    default:
      return false // deepseek-reasoner etc. think unconditionally — no parameter
  }
}

/** Anthropic request fields controlled by the thinking setting. Thinking
 *  requires temperature 1; the budget is added on top of the answer budget. */
function anthropicTuning(thinking?: ThinkingEffort): Record<string, unknown> {
  if (!thinking) return { max_tokens: 8192, temperature: 0.2 }
  const budget = THINKING_BUDGETS[thinking]
  return { max_tokens: 8192 + budget, temperature: 1, thinking: { type: 'enabled', budget_tokens: budget } }
}

/** Prepare retained history for the Anthropic wire. Thinking blocks are kept
 *  ONLY when signed and thinking is on (tool loops require the last assistant
 *  turn's signed thinking back verbatim); everything else — unsigned blocks
 *  from OpenAI-protocol models, or any thinking block while the feature is
 *  off — must be stripped or the API rejects the whole request. */
export function forAnthropicWire(messages: ApiMessage[], thinkingOn: boolean): ApiMessage[] {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m
    const blocks = (m.content as ApiContentBlock[])
      .filter(b => b.type !== 'thinking' || (thinkingOn && b.signature))
      .map(b => (b.type === 'thinking'
        ? { type: 'thinking', thinking: b.text ?? '', signature: b.signature }
        : b))
    return { ...m, content: blocks }
  })
}

export interface ApiContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  /** tool_use args failed to parse — usually truncated by the token limit */
  incompleteArgs?: boolean
  /** image block (vision): base64 payload in the Anthropic shape */
  source?: { type: 'base64'; media_type: string; data: string }
  /** thinking block: Anthropic's integrity signature — required to pass the
   *  block back during a tool loop; absent on OpenAI-protocol reasoning */
  signature?: string
}

export interface ApiResponse {
  content: ApiContentBlock[]
  stop_reason: string
  error?: { message: string }
  usage?: ApiUsage
}

export interface ApiUsage {
  inputTokens: number
  outputTokens: number
}

export function normalizeApiUsage(raw: unknown): ApiUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const root = raw as Record<string, unknown>
  const value = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, unknown> : root
  const input = value.inputTokens ?? value.input_tokens ?? value.prompt_tokens
  const output = value.outputTokens ?? value.output_tokens ?? value.completion_tokens
  if (typeof input !== 'number' && typeof output !== 'number') return undefined
  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
  }
}

function withNormalizedUsage(data: ApiResponse): ApiResponse {
  const usage = normalizeApiUsage(data)
  return usage ? { ...data, usage } : data
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
  /** request extended thinking / reasoning effort (only set for models where
   *  supportsThinking is true; absent = provider default) */
  thinking?: ThinkingEffort
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
  if (typeof expiresAt === 'number') {
    // epoch seconds (< ~2001 when read as ms) vs milliseconds
    const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt
    exp = Math.min(exp, ms - 60_000)
  }
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
async function callAnthropic(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], signal?: AbortSignal): Promise<ApiResponse> {
  const wireMessages = forAnthropicWire(messages, !!cfg.thinking)
  if (cfg.provider.id === 'bedrock') {
    // model id goes in the URL on Bedrock; auth is SigV4 in the backend
    const body = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...anthropicTuning(cfg.thinking), system, messages: wireMessages, tools })
    const raw = await bedrockInvoke(cfg.awsRegion || 'us-east-1', cfg.awsProfile, cfg.awsRefreshCmd, cfg.credCmd, cfg.model, body)
    return withNormalizedUsage(normalizeThinkingBlocks(JSON.parse(raw) as ApiResponse))
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
    body: JSON.stringify({ model: cfg.model, ...anthropicTuning(cfg.thinking), system, messages: wireMessages, tools }),
    signal,
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    // stale credential — re-run the credential command and retry once
    res = await send(await resolveKey(cfg, true))
  }
  const data = await readJsonBounded<ApiResponse>(res)
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  return withNormalizedUsage(normalizeThinkingBlocks(data))
}

/** Anthropic returns thinking blocks as { thinking, signature } with no
 *  `text`; the rest of the app reads reasoning from `.text`. Mirror it. */
function normalizeThinkingBlocks(data: ApiResponse): ApiResponse {
  if (!Array.isArray(data.content)) return data
  return {
    ...data,
    content: data.content.map(b => (b.type === 'thinking' && b.text === undefined
      ? { ...b, text: (b as ApiContentBlock & { thinking?: string }).thinking ?? '' }
      : b)),
  }
}

interface OaiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OaiMessage {
  role: string
  /** string, null, or multimodal part array (text + image_url) */
  content: string | null | unknown[]
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
    } else if (blocks.some(b => b.type === 'tool_result')) {
      for (const b of blocks as Array<{ type: string; tool_use_id?: string; content?: string }>) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content ?? '' })
      }
    } else {
      // multimodal user message: text + base64 images → OpenAI part array
      const parts = blocks.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text ?? '' }
        if (b.type === 'image' && b.source) {
          return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
        }
        return null
      }).filter((p): p is NonNullable<typeof p> => p !== null)
      out.push({ role: 'user', content: parts })
    }
  }
  return out
}

/** Adapt one request to OpenAI chat completions and normalize its response. */
async function callOpenAi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], signal?: AbortSignal): Promise<ApiResponse> {
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
      max_tokens: 8192,
      // reasoning models fix their own temperature and reject overrides
      ...(cfg.thinking ? { reasoning_effort: cfg.thinking } : { temperature: 0.2 }),
      messages: toOpenAiMessages(system, messages),
      tools: (tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
    signal,
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    // stale credential — re-run the credential command and retry once
    res = await send(await resolveKey(cfg, true))
  }
  const data = await readJsonBounded<{
    choices?: Array<{ message: OaiMessage; finish_reason: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    error?: { message: string }
  }>(res)
  if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`)
  const msg = data.choices?.[0]?.message
  const content: ApiContentBlock[] = []
  // responses are always plain text; the array form exists only for requests
  let bodyText = typeof msg?.content === 'string' ? msg.content : ''
  let thinking = msg?.reasoning_content ?? ''
  const inlineThink = bodyText.match(/^\s*<think>([\s\S]*?)<\/think>\s*/)
  if (inlineThink) {
    thinking = [thinking, inlineThink[1].trim()].filter(Boolean).join('\n')
    bodyText = bodyText.slice(inlineThink[0].length)
  }
  if (thinking) content.push({ type: 'thinking', text: thinking })
  if (bodyText) content.push({ type: 'text', text: bodyText })
  for (const tc of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    let incompleteArgs = false
    try { input = JSON.parse(tc.function.arguments || '{}') } catch { incompleteArgs = true }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input, incompleteArgs })
  }
  return { content, stop_reason: msg?.tool_calls?.length ? 'tool_use' : 'end_turn', usage: normalizeApiUsage(data) }
}

/** Route a normalized LLM request to the configured wire-protocol adapter. */
export function callApi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], signal?: AbortSignal): Promise<ApiResponse> {
  return cfg.provider.protocol === 'anthropic' ? callAnthropic(cfg, system, messages, tools, signal) : callOpenAi(cfg, system, messages, tools, signal)
}

// ---------------------------------------------------------------- streaming

/** Streaming callback: `channel` distinguishes reasoning ('thinking') from the answer. */
export type StreamDelta = (text: string, channel?: 'thinking') => void

/** Some OpenAI-compatible reasoning models inline their reasoning as
 *  <think>…</think> at the head of content. Route those spans to the thinking
 *  channel as they stream instead of showing raw tags in the answer. */
function makeThinkSplitter(route: StreamDelta): { push: (chunk: string) => void; flush: () => void } {
  let mode: 'start' | 'text' | 'think' = 'start'
  let buf = ''
  const step = (): boolean => {
    if (mode === 'start') {
      const lead = buf.replace(/^\s+/, '')
      if (!lead) return false
      if ('<think>'.startsWith(lead.slice(0, 7))) {
        if (!lead.startsWith('<think>')) return false // may still become <think> — wait
        mode = 'think'
        buf = lead.slice(7)
        return true
      }
      mode = 'text'
      buf = lead
      return true
    }
    if (mode === 'think') {
      const end = buf.indexOf('</think>')
      if (end === -1) {
        const safe = Math.max(0, buf.length - 8) // hold back a partial closing tag
        if (safe) {
          route(buf.slice(0, safe), 'thinking')
          buf = buf.slice(safe)
        }
        return false
      }
      if (end) route(buf.slice(0, end), 'thinking')
      buf = buf.slice(end + 8)
      mode = 'start' // a second reasoning span is legal; text otherwise
      return true
    }
    if (buf) route(buf)
    buf = ''
    return false
  }
  return {
    push: chunk => {
      buf += chunk
      while (step()) { /* consume */ }
    },
    flush: () => {
      if (!buf) return
      route(buf, mode === 'think' ? 'thinking' : undefined)
      buf = ''
    },
  }
}

/** Consume an SSE response — incrementally when the body streams, or from the
 *  buffered text otherwise (plugin fallback) — invoking onData per event. */
async function consumeSse(res: Response, onData: (data: string) => void): Promise<void> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES} byte limit`)
  }
  const process = (chunk: string, carry: string): string => {
    const text = carry + chunk
    const lines = text.split('\n')
    const rest = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('data:')) {
        const payload = t.slice(5).trim()
        if (payload && payload !== '[DONE]') onData(payload)
      }
    }
    return rest
  }
  if (res.body) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`API response exceeds the ${MAX_RESPONSE_BYTES} byte limit`)
      }
      carry = process(decoder.decode(value, { stream: true }), carry)
    }
    process('\n', carry)
  } else {
    process(await readTextBounded(res) + '\n', '')
  }
}

/** Streaming Anthropic Messages call: text deltas flow through onDelta. */
async function streamAnthropic(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], onDelta: StreamDelta, signal?: AbortSignal): Promise<ApiResponse> {
  const anthropicBase = (cfg.provider.id === 'anthropic-compat' ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  const send = async (key: string) => doFetch(`${anthropicBase}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...anthropicAuthHeaders(key),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: cfg.model, ...anthropicTuning(cfg.thinking), system, messages: forAnthropicWire(messages, !!cfg.thinking), tools, stream: true }),
    signal,
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    res = await send(await resolveKey(cfg, true))
  }
  if (!res.ok) {
    const data = await readJsonBounded<ApiResponse>(res, 256 * 1024).catch(() => null)
    throw new Error(data?.error?.message || `API error ${res.status}`)
  }
  const blocks: (ApiContentBlock & { partialJson?: string })[] = []
  let stopReason = 'end_turn'
  let streamError: string | null = null
  let usage: ApiUsage | undefined
  await consumeSse(res, data => {
    let ev: Record<string, unknown>
    try { ev = JSON.parse(data) } catch { return }
    const index = Number(ev.index ?? 0)
    const eventUsage = normalizeApiUsage(ev.type === 'message_start' ? ev.message : ev)
    if (eventUsage) usage = {
      inputTokens: Math.max(usage?.inputTokens ?? 0, eventUsage.inputTokens),
      outputTokens: Math.max(usage?.outputTokens ?? 0, eventUsage.outputTokens),
    }
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block as { type: string; id?: string; name?: string; text?: string }
      blocks[index] = cb.type === 'tool_use'
        ? { type: 'tool_use', id: cb.id, name: cb.name, input: {}, partialJson: '' }
        : { type: cb.type, text: cb.text ?? '' }
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[index]
      if (!b) return
      const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string; signature?: string }
      if (d.type === 'text_delta' && d.text) {
        b.text = (b.text ?? '') + d.text
        onDelta(d.text)
      } else if (d.type === 'thinking_delta' && d.thinking) {
        b.text = (b.text ?? '') + d.thinking
        onDelta(d.thinking, 'thinking')
      } else if (d.type === 'signature_delta' && d.signature) {
        // thinking-block integrity signature — must round-trip in tool loops
        b.signature = (b.signature ?? '') + d.signature
      } else if (d.type === 'input_json_delta' && d.partial_json) {
        b.partialJson = (b.partialJson ?? '') + d.partial_json
      }
    } else if (ev.type === 'message_delta') {
      const d = ev.delta as { stop_reason?: string } | undefined
      if (d?.stop_reason) stopReason = d.stop_reason
    } else if (ev.type === 'error') {
      streamError = (ev.error as { message?: string } | undefined)?.message ?? 'stream error'
    }
  })
  if (streamError) throw new Error(streamError)
  const content = blocks.filter(Boolean).map(b => {
    if (b.type !== 'tool_use') return b
    let input: Record<string, unknown> = {}
    let incompleteArgs = false
    try { input = JSON.parse(b.partialJson || '{}') } catch { incompleteArgs = true }
    return { type: 'tool_use', id: b.id, name: b.name, input, incompleteArgs }
  })
  return { content, stop_reason: stopReason, usage }
}

/** Streaming OpenAI chat-completions call: content deltas flow through onDelta. */
async function streamOpenAi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], onDelta: StreamDelta, signal?: AbortSignal): Promise<ApiResponse> {
  const base = (cfg.provider.models.length === 0 && cfg.baseUrl ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  if (!base) throw new Error('custom provider needs a base URL')
  const send = async (key: string) => doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      // reasoning models fix their own temperature and reject overrides
      ...(cfg.thinking ? { reasoning_effort: cfg.thinking } : { temperature: 0.2 }),
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAiMessages(system, messages),
      tools: (tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
    signal,
  })
  let res = await send(await resolveKey(cfg))
  if ((res.status === 401 || res.status === 403) && cfg.credCmd.trim()) {
    res = await send(await resolveKey(cfg, true))
  }
  if (!res.ok) {
    const data = await readJsonBounded<{ error?: { message?: string } }>(res, 256 * 1024).catch(() => null)
    throw new Error(data?.error?.message || `API error ${res.status}`)
  }
  let text = ''
  let reasoning = ''
  const route: StreamDelta = (t, ch) => {
    if (ch === 'thinking') reasoning += t
    else text += t
    onDelta(t, ch)
  }
  const splitter = makeThinkSplitter(route)
  const calls: { id: string; name: string; args: string }[] = []
  let finish = ''
  let usage: ApiUsage | undefined
  await consumeSse(res, data => {
    let ev: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    try { ev = JSON.parse(data) } catch { return }
    usage = normalizeApiUsage(ev) ?? usage
    const c = ev.choices?.[0]
    if (!c) return
    if (c.delta?.content) splitter.push(c.delta.content)
    if (c.delta?.reasoning_content) route(c.delta.reasoning_content, 'thinking')
    for (const tc of c.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0
      calls[idx] = calls[idx] ?? { id: '', name: '', args: '' }
      if (tc.id) calls[idx].id = tc.id
      if (tc.function?.name) calls[idx].name += tc.function.name
      if (tc.function?.arguments) calls[idx].args += tc.function.arguments
    }
    if (c.finish_reason) finish = c.finish_reason
  })
  splitter.flush()
  const content: ApiContentBlock[] = []
  if (reasoning) content.push({ type: 'thinking', text: reasoning })
  if (text) content.push({ type: 'text', text })
  for (const tc of calls.filter(Boolean)) {
    let input: Record<string, unknown> = {}
    let incompleteArgs = false
    try { input = JSON.parse(tc.args || '{}') } catch { incompleteArgs = true }
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input, incompleteArgs })
  }
  return { content, stop_reason: calls.filter(Boolean).length || finish === 'tool_calls' ? 'tool_use' : 'end_turn', usage }
}

/** Streaming variant of callApi: text deltas arrive through onDelta as the
 *  model produces them. Bedrock's invoke bridge cannot stream — it falls back
 *  to the buffered call (onDelta simply never fires). */
export function callApiStream(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[], onDelta: StreamDelta, signal?: AbortSignal): Promise<ApiResponse> {
  if (cfg.provider.id === 'bedrock') return callAnthropic(cfg, system, messages, tools, signal)
  return cfg.provider.protocol === 'anthropic'
    ? streamAnthropic(cfg, system, messages, tools, onDelta, signal)
    : streamOpenAi(cfg, system, messages, tools, onDelta, signal)
}

/** Whether the settings hold usable credentials for the chosen provider.
 *  Bedrock has no API key — it authenticates via the AWS credential chain. */
export function hasCreds(settings: AppState['settings']): boolean {
  return settings.provider === 'bedrock' || Boolean(settings.apiKey) || Boolean(settings.credCmd.trim())
}

/** Config for a chat-agent type: its own provider/key/base, falling back to
 *  the Master Brain credentials when it shares the provider and sets no key. */
export function buildChatCfg(
  t: { provider: string; model: string; apiKey?: string; baseUrl?: string; effort?: ThinkingEffort },
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
    // a persisted effort survives model switches — only send it where valid
    ...(t.effort && supportsThinking(t.provider, t.model) ? { thinking: t.effort } : {}),
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
