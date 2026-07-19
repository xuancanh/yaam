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
      task: 'older task label', summary: 'Running the authentication tests', nextAction: 'Verify the callback flow', actionNeeded: 'Choose an OAuth scope',
    }), task())).toEqual({
      task: 'Repair login', current: 'Running the authentication tests', next: 'Choose an OAuth scope', nextDetail: undefined,
    })
  })

  it('uses the first concrete suggestion as the next action', () => {
    expect(sessionWorkStatus(agent({ suggestions: [{ id: 's1', label: 'Retry tests', send: 'npm test' }] }), task())).toMatchObject({
      next: 'Retry tests', nextDetail: 'npm test',
    })
  })

  it('does not expose extractive terminal history while waiting for a monitor brief', () => {
    const stopped = agent({
      status: 'idle', history: [{ id: 'h1', at: 1, category: 'work', actor: 'session', kind: 'changes', text: 'Changed two files' }],
    })
    expect(sessionWorkStatus(stopped)).toMatchObject({
      task: 'Waiting for watcher task summary', current: 'Idle', next: 'Resume when ready',
    })
  })

  it('uses the task watcher for now and next ahead of worker status', () => {
    expect(sessionWorkStatus(
      agent({ summary: 'stale worker summary', nextAction: 'stale worker next' }),
      task({ watcherNote: 'Reviewing the authentication diff', watcherNext: 'Run the focused integration tests' }),
    )).toMatchObject({
      current: 'Reviewing the authentication diff', next: 'Run the focused integration tests',
    })
  })

  it('describes an unstarted task without inventing session activity', () => {
    expect(sessionWorkStatus(undefined, task({ agentId: null, col: 'backlog' }))).toMatchObject({
      current: 'Waiting to start', next: 'Start a session',
    })
  })
})
