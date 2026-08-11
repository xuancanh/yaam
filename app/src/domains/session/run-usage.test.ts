import { describe, expect, it } from 'vitest'
import { formatUsage, usageFromTranscript } from './run-usage'

describe('usageFromTranscript', () => {
  it('sums claude per-message usage and counts assistant turns', () => {
    const usage = usageFromTranscript([
      { type: 'user' },
      { type: 'assistant', message: { usage: { input_tokens: 1000, output_tokens: 200 } } },
      { type: 'assistant', message: { usage: { input_tokens: 3000, output_tokens: 800 } } },
      { type: 'assistant', message: {} }, // no usage — ignored
    ])
    expect(usage).toEqual({ inputTokens: 4000, outputTokens: 1000, assistantTurns: 2 })
  })

  it('codex cumulative token_count events: the last one wins', () => {
    const usage = usageFromTranscript([
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 100 } } } },
      { type: 'event_msg', payload: { type: 'other' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000, output_tokens: 1500 } } } },
    ])
    expect(usage).toEqual({ inputTokens: 9000, outputTokens: 1500 })
  })

  it('returns undefined when nothing carries usage', () => {
    expect(usageFromTranscript([])).toBeUndefined()
    expect(usageFromTranscript([{ type: 'user' }, { type: 'response_item' }])).toBeUndefined()
  })
})

describe('formatUsage', () => {
  it('renders compact counts', () => {
    expect(formatUsage({ inputTokens: 123_456, outputTokens: 4200, assistantTurns: 7 })).toBe('123.5k in / 4200 out · 7 turns')
    expect(formatUsage({ inputTokens: 900, outputTokens: 12_000 })).toBe('900 in / 12.0k out')
  })
})
