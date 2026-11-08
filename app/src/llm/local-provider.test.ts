import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCfg, buildMonitorCfg, callApi, hasCreds, openAiBase, providerFor } from './client'
import type { AppState } from '../core/types'

const base = {
  provider: 'anthropic', apiKey: 'sk-ant', baseUrl: '', masterModel: 'claude-sonnet-5', monitorModel: '',
  awsRegion: '', awsProfile: '', awsRefreshCmd: '', credCmd: '',
} as unknown as AppState['settings']
const settings = (over: Partial<AppState['settings']>) => ({ ...base, ...over }) as AppState['settings']

afterEach(() => vi.unstubAllGlobals())

describe('local provider', () => {
  it('needs no key', () => {
    expect(hasCreds(settings({ provider: 'local', apiKey: '' }))).toBe(true)
  })

  it('defaults to Ollama and honors a base URL override', () => {
    const local = providerFor('local')
    expect(openAiBase({ provider: local, baseUrl: '' })).toBe('http://localhost:11434/v1')
    expect(openAiBase({ provider: local, baseUrl: 'http://127.0.0.1:8080/v1/' })).toBe('http://127.0.0.1:8080/v1')
    // fixed hosted providers ignore a stray base URL
    expect(openAiBase({ provider: providerFor('openai'), baseUrl: 'http://x' })).toBe('https://api.openai.com/v1')
  })

  it('sends no auth header and turns off qwen3 thinking', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const cfg = buildCfg(settings({ provider: 'local', apiKey: '', masterModel: 'qwen3:1.7b' }))
    await callApi(cfg, 'sys', [{ role: 'user', content: 'hi' }], [])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys\n\n/no_think' })
  })
})

describe('buildMonitorCfg', () => {
  it('shares Master credentials and uses the cheaper model by default', () => {
    const cfg = buildMonitorCfg(settings({ monitorModel: 'claude-haiku-4-5-20251001' }))
    expect(cfg.provider.id).toBe('anthropic')
    expect(cfg.apiKey).toBe('sk-ant')
    expect(cfg.model).toBe('claude-haiku-4-5-20251001')
  })

  it('runs monitors locally without leaking the remote key', () => {
    const cfg = buildMonitorCfg(settings({ monitorProvider: 'local', monitorBaseUrl: 'http://localhost:1234/v1' }))
    expect(cfg.provider.id).toBe('local')
    expect(cfg.apiKey).toBe('')
    expect(cfg.credCmd).toBe('')
    expect(cfg.baseUrl).toBe('http://localhost:1234/v1')
    expect(cfg.model).toBe('qwen3:1.7b')
  })
})
