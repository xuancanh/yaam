import { describe, expect, it } from 'vitest'
import { capChatHistory, sanitizeChatHistory } from './agent'
import { opensClean, toolPairsIntact } from '../../llm/history-invariants'
import type { ApiMessage } from '../../llm/client'

// REGRESSION: the chat turn capped its persistent history with blind shift()s
// (`role !== 'user'` lets an orphaned tool_result carrier through — it has
// role 'user'). Past ~58 entries the cap could split a tool_use/tool_result
// pair; providers reject such a conversation on every later call, and chat
// histories PERSIST, so the corruption survived restarts. Chat also needs its
// own sanitizer: conversations legitimately open with attachment block arrays
// that the strict tool-loop sanitizer would drop.

const toolPair = (id: string): ApiMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_file', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] as never },
]

const attachmentOpener: ApiMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'what is in this screenshot?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
  ],
}

describe('sanitizeChatHistory', () => {
  it('drops a dangling tool round at the tail (aborted turn debris)', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'run_command', input: {} }] },
    ]
    sanitizeChatHistory(history)
    expect(history).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('drops an orphaned tool_result opener even though its role is user', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'ok' }] as never },
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'answer' },
    ]
    sanitizeChatHistory(history)
    expect(history[0]).toEqual({ role: 'user', content: 'follow-up' })
    expect(opensClean(history, { allowArrays: true })).toBe(true)
  })

  it('keeps attachment block arrays as openers (unlike the tool-loop sanitizer)', () => {
    const history: ApiMessage[] = [attachmentOpener, { role: 'assistant', content: 'a cat' }]
    sanitizeChatHistory(history)
    expect(history).toHaveLength(2)
    expect(history[0]).toBe(attachmentOpener)
  })
})

describe('capChatHistory', () => {
  it('capping a long history never splits tool pairs or opens with debris', () => {
    const history: ApiMessage[] = []
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `msg ${i}` })
      history.push(...toolPair(`call-${i}`))
      history.push({ role: 'assistant', content: `reply ${i}` })
    }
    // 80 entries; every cap point in this range lands inside or beside a tool round
    for (let max = 3; max <= 12; max++) {
      const h = history.map(m => ({ ...m }))
      capChatHistory(h, max)
      expect(h.length, `max=${max}`).toBeLessThanOrEqual(max)
      expect(toolPairsIntact(h), `max=${max}`).toBe(true)
      expect(opensClean(h, { allowArrays: true }), `max=${max}`).toBe(true)
    }
  })
})
