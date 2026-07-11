import { describe, expect, it } from 'vitest'
import { buildChatCfg, forAnthropicWire, supportsThinking } from './client'
import type { ApiMessage } from './client'
import type { AppState } from '../core/types'

const settings = {
  provider: 'anthropic', apiKey: 'k', baseUrl: '', masterModel: 'claude-sonnet-5',
  awsRegion: '', awsProfile: '', awsRefreshCmd: '', credCmd: '',
} as unknown as AppState['settings']

describe('supportsThinking', () => {
  it('accepts modern claude models on anthropic-protocol providers', () => {
    expect(supportsThinking('anthropic', 'claude-sonnet-5')).toBe(true)
    expect(supportsThinking('anthropic', 'claude-haiku-4-5-20251001')).toBe(true)
    expect(supportsThinking('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true)
    expect(supportsThinking('anthropic-compat', 'claude-opus-4-8')).toBe(true)
  })
  it('rejects pre-thinking claude generations', () => {
    expect(supportsThinking('anthropic', 'claude-3-5-sonnet-20241022')).toBe(false)
    expect(supportsThinking('anthropic', 'claude-3-0-haiku')).toBe(false)
  })
  it('accepts openai o-series / gpt-5 and gemini 2.x, nothing else', () => {
    expect(supportsThinking('openai', 'o4-mini')).toBe(true)
    expect(supportsThinking('openai', 'gpt-5')).toBe(true)
    expect(supportsThinking('openai', 'gpt-4o')).toBe(false)
    expect(supportsThinking('gemini', 'gemini-2.5-pro')).toBe(true)
    expect(supportsThinking('deepseek', 'deepseek-reasoner')).toBe(false)
    expect(supportsThinking('kimi', 'kimi-latest')).toBe(false)
    expect(supportsThinking('custom', 'anything')).toBe(false)
  })
})

describe('buildChatCfg effort gating', () => {
  it('passes the effort through only when the model supports thinking', () => {
    const on = buildChatCfg({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' }, settings)
    expect(on.thinking).toBe('high')
    const off = buildChatCfg({ provider: 'deepseek', model: 'deepseek-chat', effort: 'high' }, settings)
    expect(off.thinking).toBeUndefined()
    const none = buildChatCfg({ provider: 'anthropic', model: 'claude-sonnet-5' }, settings)
    expect(none.thinking).toBeUndefined()
  })
})

describe('forAnthropicWire', () => {
  const history: ApiMessage[] = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'signed reasoning', signature: 'sig-1' },
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 'tu1', name: 'run', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'unsigned reasoning from an openai model' },
        { type: 'text', text: 'done' },
      ],
    },
  ]

  it('keeps signed thinking (converted to the wire shape) when thinking is on', () => {
    const wire = forAnthropicWire(history, true)
    const first = wire[1].content as Array<Record<string, unknown>>
    expect(first[0]).toEqual({ type: 'thinking', thinking: 'signed reasoning', signature: 'sig-1' })
    // unsigned reasoning must never go over the anthropic wire
    const last = wire[3].content as Array<Record<string, unknown>>
    expect(last.every(b => b.type !== 'thinking')).toBe(true)
  })

  it('strips every thinking block when thinking is off', () => {
    const wire = forAnthropicWire(history, false)
    for (const m of wire) {
      if (!Array.isArray(m.content)) continue
      expect((m.content as Array<{ type: string }>).every(b => b.type !== 'thinking')).toBe(true)
    }
  })

  it('leaves plain-string messages and tool blocks untouched', () => {
    const wire = forAnthropicWire(history, true)
    expect(wire[0]).toEqual(history[0])
    const first = wire[1].content as Array<{ type: string }>
    expect(first.map(b => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(wire[2]).toEqual(history[2])
  })
})
