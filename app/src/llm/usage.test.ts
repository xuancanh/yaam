import { describe, expect, it } from 'vitest'
import { CACHE_SPLIT, normalizeApiUsage, withCacheBreakpoints } from './client'

describe('normalizeApiUsage', () => {
  it('normalizes Anthropic usage', () => {
    expect(normalizeApiUsage({ usage: { input_tokens: 120, output_tokens: 30 } }))
      .toEqual({ inputTokens: 120, outputTokens: 30 })
  })

  it('normalizes OpenAI usage', () => {
    expect(normalizeApiUsage({ prompt_tokens: 80, completion_tokens: 20 }))
      .toEqual({ inputTokens: 80, outputTokens: 20 })
  })

  it('leaves missing usage unknown', () => {
    expect(normalizeApiUsage({ choices: [] })).toBeUndefined()
  })
})

describe('prompt caching', () => {
  it('counts cached prefix tokens as input', () => {
    expect(normalizeApiUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 5 } }))
      .toEqual({ inputTokens: 1000, outputTokens: 5 })
  })
  it('marks tools, the stable system head and the newest message', () => {
    const out = withCacheBreakpoints(`rules${CACHE_SPLIT}live state`, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'thinking', text: '' }] },
    ], [{ name: 't1' }, { name: 't2' }])
    expect(out.tools).toEqual([{ name: 't1' }, { name: 't2', cache_control: { type: 'ephemeral' } }])
    expect(out.system).toEqual([{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'live state' }])
    expect(out.messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect(out.messages[1].content).toEqual([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'thinking', text: '' }])
  })
})
