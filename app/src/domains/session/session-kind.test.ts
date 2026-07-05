import { describe, expect, it } from 'vitest'
import { isChatSession, isPtySession } from './session-kind'
import type { Agent } from '../../core/types'

const agent = (over: Partial<Agent>): Agent => ({ id: 'a', name: 'a', ...over } as unknown as Agent)

describe('session-kind guards', () => {
  it('isChatSession narrows a chat agent with a chatLog array', () => {
    const a = agent({ kind: 'chat', chatLog: [] })
    expect(isChatSession(a)).toBe(true)
    if (isChatSession(a)) expect(Array.isArray(a.chatLog)).toBe(true) // typed as present
  })

  it('isChatSession rejects a real session and a chat missing its chatLog', () => {
    expect(isChatSession(agent({ kind: 'real', cmd: 'claude' }))).toBe(false)
    expect(isChatSession(agent({ kind: 'chat' }))).toBe(false) // no chatLog yet
  })

  it('isPtySession narrows a launched real session with a cmd', () => {
    const a = agent({ kind: 'real', cmd: 'claude' })
    expect(isPtySession(a)).toBe(true)
    if (isPtySession(a)) expect(typeof a.cmd).toBe('string')
  })

  it('isPtySession rejects a chat session and a real session without a cmd', () => {
    expect(isPtySession(agent({ kind: 'chat', chatLog: [] }))).toBe(false)
    expect(isPtySession(agent({ kind: 'real' }))).toBe(false)
  })
})
