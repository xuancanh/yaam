import { describe, expect, it } from 'vitest'
import { sanitizeToolHistory } from './tool-loop'
import type { ApiMessage } from './client'

const toolUse = (id: string): ApiMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 't', input: {} }] })
const toolResult = (id: string): ApiMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] })

describe('sanitizeToolHistory', () => {
  it('drops a dangling trailing tool round (aborted mid-turn)', () => {
    const h: ApiMessage[] = [
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'done' },
      toolUse('a'), // aborted before its result arrived
    ]
    sanitizeToolHistory(h)
    expect(h).toHaveLength(2)
    expect(h[1].content).toBe('done')
  })

  it('drops leading messages until a plain user string opens the conversation', () => {
    // the exact corruption a blind length-cap produces: history OPENS with an
    // orphaned tool_result — providers reject every call from then on,
    // permanently muting the watcher
    const h: ApiMessage[] = [
      toolResult('lost-pair'),
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'status?' },
      { role: 'assistant', content: 'all good' },
    ]
    sanitizeToolHistory(h)
    expect(h[0]).toEqual({ role: 'user', content: 'status?' })
    expect(h).toHaveLength(2)
  })

  it('keeps a healthy history untouched (paired rounds included)', () => {
    const h: ApiMessage[] = [
      { role: 'user', content: 'go' },
      toolUse('a'),
      toolResult('a'),
      { role: 'assistant', content: 'finished' },
    ]
    const before = JSON.stringify(h)
    sanitizeToolHistory(h)
    expect(JSON.stringify(h)).toBe(before)
  })

  it('empties a history that is nothing but debris', () => {
    const h: ApiMessage[] = [toolResult('x'), toolUse('y')]
    sanitizeToolHistory(h)
    expect(h).toHaveLength(0)
  })
})
