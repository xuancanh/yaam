import { describe, expect, it } from 'vitest'
import type { Agent, BoardTask } from '../../core/types'
import { sessionWorkStatus } from './session-work-status'

const agent = (patch: Partial<Agent> = {}) => ({
  id: 'a1', name: 'Agent', status: 'running', log: [], history: [], suggestions: [],
  archived: false, ...patch,
} as Agent)

const task = (patch: Partial<BoardTask> = {}) => ({
  id: 't1', title: 'Repair login', col: 'progress', agentId: 'a1', ...patch,
} as BoardTask)

describe('sessionWorkStatus', () => {
  it('prefers explicit task, monitor summary, and required user action', () => {
    expect(sessionWorkStatus(agent({
      task: 'older task label', summary: 'Running the authentication tests', actionNeeded: 'Choose an OAuth scope',
    }), task())).toEqual({
      task: 'Repair login', current: 'Running the authentication tests', next: 'Choose an OAuth scope', nextDetail: undefined,
    })
  })

  it('uses the first concrete suggestion as the next action', () => {
    expect(sessionWorkStatus(agent({ suggestions: [{ id: 's1', label: 'Retry tests', send: 'npm test' }] }), task())).toMatchObject({
      next: 'Retry tests', nextDetail: 'npm test',
    })
  })

  it('falls back to durable work history and lifecycle actions', () => {
    const stopped = agent({
      status: 'idle', history: [{ id: 'h1', at: 1, category: 'work', actor: 'session', kind: 'changes', text: 'Changed two files' }],
    })
    expect(sessionWorkStatus(stopped)).toMatchObject({
      task: 'Unassigned session', current: 'Changed two files', next: 'Resume when ready',
    })
  })

  it('describes an unstarted task without inventing session activity', () => {
    expect(sessionWorkStatus(undefined, task({ agentId: null, col: 'backlog' }))).toMatchObject({
      current: 'Waiting to start', next: 'Start a session',
    })
  })
})
