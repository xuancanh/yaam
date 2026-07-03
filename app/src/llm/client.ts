// LLM providers and protocol adapters (Anthropic Messages / OpenAI-compatible
// chat completions). HTTP goes through the Tauri backend to avoid CORS.
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from '../native'
import type { AppState } from '../types'

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
  { id: 'custom', label: 'Custom (OpenAI-compatible)', base: '', protocol: 'openai', models: [], keyHint: 'api key' },
]

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
}

async function callAnthropic(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  const res = await doFetch(`${cfg.provider.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model: cfg.model, max_tokens: 2048, temperature: 0.2, system, messages, tools }),
  })
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

async function callOpenAi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  const base = (cfg.provider.id === 'custom' ? cfg.baseUrl : cfg.provider.base).replace(/\/$/, '')
  if (!base) throw new Error('custom provider needs a base URL (Settings → Master Brain)')
  const res = await doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      temperature: 0.2,
      messages: toOpenAiMessages(system, messages),
      tools: (tools as Array<{ name: string; description: string; input_schema: unknown }>).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  })
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

export function callApi(cfg: LlmConfig, system: string, messages: ApiMessage[], tools: unknown[]): Promise<ApiResponse> {
  return cfg.provider.protocol === 'anthropic' ? callAnthropic(cfg, system, messages, tools) : callOpenAi(cfg, system, messages, tools)
}

export function buildCfg(settings: AppState['settings'], modelOverride?: string): LlmConfig {
  return {
    provider: providerFor(settings.provider),
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: modelOverride || settings.masterModel,
  }
}


