import { describe, expect, it } from 'vitest'
import type { Agent, ChatTurn } from '../../core/types'
import { buildContextSummary, lastReplayableTurn, removeStructuredTurn, rewindFromTurn } from './turns'

const turn = (id: string, status: ChatTurn['status']): ChatTurn => ({
  id, status, at: 1, startedAt: 1, model: 'test', input: { text: id, attachments: [] }, tools: [],
})

const agent = {
  id: 'chat', kind: 'chat', chatTurns: [turn('done', 'complete'), turn('live', 'running')],
  chatLog: [
    { id: 'm1', role: 'user', text: 'one', at: 1, turnId: 'done' },
    { id: 'm2', role: 'assistant', text: 'two', at: 2, turnId: 'done' },
    { id: 'm3', role: 'user', text: 'three', at: 3, turnId: 'live' },
  ],
} as unknown as Agent

describe('structured chat turns', () => {
  it('selects the newest settled turn for replay', () => {
    expect(lastReplayableTurn(agent)?.id).toBe('done')
  })

  it('removes only messages belonging to the replayed turn', () => {
    const next = removeStructuredTurn(agent, 'done')
    expect(next.chatTurns?.map(t => t.id)).toEqual(['live'])
    expect(next.chatLog?.map(m => m.id)).toEqual(['m3'])
  })

  it('rewinds the selected turn and every turn after it', () => {
    const source = {
      ...agent,
      chatTurns: [turn('one', 'complete'), turn('two', 'complete'), turn('three', 'complete')],
      chatLog: [
        { id: 'intro', role: 'assistant', text: 'hi', at: 0 },
        { id: 'one', role: 'user', text: 'one', at: 1, turnId: 'one' },
        { id: 'two', role: 'user', text: 'two', at: 2, turnId: 'two' },
        { id: 'three', role: 'user', text: 'three', at: 3, turnId: 'three' },
      ],
    } as unknown as Agent
    const next = rewindFromTurn(source, 'two')
    expect(next.chatTurns?.map(t => t.id)).toEqual(['one'])
    expect(next.chatLog?.map(m => m.id)).toEqual(['intro', 'one'])
  })

  it('summarizes only turns older than the recent context window', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      ...turn(`turn-${i}`, 'complete'), at: Date.UTC(2026, 0, i + 1),
      input: { text: `request ${i}`, attachments: [] }, assistantText: `answer ${i}`,
    }))
    const summary = buildContextSummary(many, 12)
    expect(summary).toContain('request 0')
    expect(summary).toContain('request 2')
    expect(summary).not.toContain('request 3')
  })
})
