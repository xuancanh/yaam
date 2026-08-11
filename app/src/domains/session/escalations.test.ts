import { describe, expect, it } from 'vitest'
import { pendingEscalation } from './escalations'
import type { Escalation, Message } from '../../core/types'

const esc = (over: Partial<Escalation>): Escalation =>
  ({ name: 'A', color: '#fff', repo: 'r', reason: 'Proceed?', resolved: false, decision: null, ...over })

const msg = (id: string, escFor: string, e: Escalation): Message =>
  ({ id, role: 'master', kind: 'escalate', escFor, esc: e }) as Message

describe('pendingEscalation', () => {
  it('returns the latest unresolved card for the session', () => {
    const messages = [
      msg('m1', 'a1', esc({ reason: 'old', resolved: true })),
      msg('m2', 'a1', esc({ reason: 'first pending' })),
      msg('m3', 'a2', esc({ reason: 'other session' })),
      msg('m4', 'a1', esc({ reason: 'latest pending', options: [{ num: 1, label: 'Yes' }] })),
    ]
    expect(pendingEscalation(messages, 'a1')?.reason).toBe('latest pending')
    expect(pendingEscalation(messages, 'a1')?.options).toHaveLength(1)
    expect(pendingEscalation(messages, 'a2')?.reason).toBe('other session')
  })
  it('resolved-only history yields nothing', () => {
    const messages = [msg('m1', 'a1', esc({ resolved: true }))]
    expect(pendingEscalation(messages, 'a1')).toBeUndefined()
    expect(pendingEscalation([], 'a1')).toBeUndefined()
  })
})
