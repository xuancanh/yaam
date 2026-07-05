import { describe, expect, it } from 'vitest'
import { stripImagesFromHistory } from './agent'
import type { ApiMessage } from '../../llm/client'

const img = (data = 'AAAA') => ({ type: 'image', source: { type: 'base64' as const, media_type: 'image/png', data } })

describe('stripImagesFromHistory', () => {
  it('replaces image blocks with text notes and flattens all-text arrays to strings', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'plain question' },
      { role: 'user', content: [{ type: 'text', text: 'what is in this screenshot?' }, img()] },
      { role: 'assistant', content: 'an answer' },
    ]
    expect(stripImagesFromHistory(history)).toBe(true)
    expect(history[0].content).toBe('plain question') // untouched
    expect(typeof history[1].content).toBe('string') // flattened: text-only now
    expect(history[1].content).toContain('what is in this screenshot?')
    expect(history[1].content).toContain('image omitted')
    expect(JSON.stringify(history)).not.toContain('base64') // no payload survives
  })

  it('keeps arrays that still carry non-text blocks (tool results)', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, img()] },
    ]
    expect(stripImagesFromHistory(history)).toBe(true)
    expect(Array.isArray(history[0].content)).toBe(true)
    const blocks = history[0].content as { type: string }[]
    expect(blocks.map(b => b.type)).toEqual(['tool_result', 'text'])
  })

  it('returns false when there is nothing to strip', () => {
    const history: ApiMessage[] = [{ role: 'user', content: 'hi' }]
    expect(stripImagesFromHistory(history)).toBe(false)
    expect(history[0].content).toBe('hi')
  })
})
