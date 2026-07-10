import { describe, expect, it } from 'vitest'
import { normalizeApiUsage } from './client'

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
