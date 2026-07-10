import { describe, expect, it } from 'vitest'
import { groupRuns, runGroupOf, runMatchesFilter, runStatusLabel } from './mission-state'
import type { Agent, BoardTask } from '../../core/types'

const task = (over: Partial<BoardTask>): BoardTask =>
  ({ id: 't1', title: 'Task', col: 'progress', chat: [], ...over }) as BoardTask

const agent = (over: Partial<Agent>): Agent =>
  ({ id: 'a1', name: 'A', status: 'idle', kind: 'real', log: [], memory: [], tools: [], ...over }) as unknown as Agent

describe('runGroupOf / runStatusLabel', () => {
  it('anything waiting on the user wins, including review-column tasks', () => {
    const r1 = { kind: 'task' as const, key: 'task:t1', task: task({ awaitingUser: true }), agent: agent({ status: 'running' }) }
    expect(runGroupOf(r1)).toBe('needs')
    expect(runStatusLabel(r1).label).toBe('waiting on you')
    const r2 = { kind: 'task' as const, key: 'task:t2', task: task({ col: 'review' }) }
    expect(runGroupOf(r2)).toBe('needs')
    expect(runStatusLabel(r2).label).toBe('review')
    const r3 = { kind: 'session' as const, key: 'sess:a1', agent: agent({ status: 'needs' }) }
    expect(runGroupOf(r3)).toBe('needs')
  })
  it('live agents run, unstarted backlog tasks are startable, finished tasks are done, the rest idles', () => {
    expect(runGroupOf({ kind: 'session', key: 'sess:a1', agent: agent({ status: 'running' }) })).toBe('running')
    expect(runGroupOf({ kind: 'task', key: 'task:t1', task: task({ col: 'done' }) })).toBe('done')
    expect(runGroupOf({ kind: 'task', key: 'task:t1', task: task({ col: 'backlog' }) })).toBe('backlog')
    expect(runGroupOf({ kind: 'session', key: 'sess:a1', agent: agent({ status: 'idle' }) })).toBe('idle')
  })
})

describe('runMatchesFilter', () => {
  const taskRun = { kind: 'task' as const, key: 'task:t1', task: task({}) }
  const sessRun = { kind: 'session' as const, key: 'sess:a1', agent: agent({}) }
  it('splits tasks from sessions', () => {
    expect(runMatchesFilter(taskRun, 'task')).toBe(true)
    expect(runMatchesFilter(taskRun, 'session')).toBe(false)
    expect(runMatchesFilter(sessRun, 'session')).toBe(true)
    expect(runMatchesFilter(sessRun, 'all')).toBe(true)
  })
  it('scheduled = pending start time or schedule-created', () => {
    expect(runMatchesFilter(taskRun, 'scheduled')).toBe(false)
    expect(runMatchesFilter({ ...taskRun, task: task({ scheduleAt: 123 }) }, 'scheduled')).toBe(true)
    const cronMade = task({ chat: [{ id: 'c1', role: 'system', text: 'Added by schedule “nightly”', at: 1 }] })
    expect(runMatchesFilter({ ...taskRun, task: cronMade }, 'scheduled')).toBe(true)
    expect(runMatchesFilter(sessRun, 'scheduled')).toBe(false)
  })
})

describe('groupRuns', () => {
  it('folds tasks and loose sessions, skipping archived, chat, and task-owned agents', () => {
    const a1 = agent({ id: 'a1', status: 'running' })
    const a2 = agent({ id: 'a2', status: 'running' })
    const chat = agent({ id: 'a3', kind: 'chat', status: 'running' })
    const gone = agent({ id: 'a4', archived: true })
    const t1 = task({ id: 't1', agentId: 'a1', agentIds: ['a1'] })
    const groups = groupRuns([t1, task({ id: 't2', archived: true })], [a1, a2, chat, gone])
    const keys = groups.flatMap(g => g.runs.map(r => r.key))
    expect(keys).toEqual(['task:t1', 'sess:a2'])
    // the task run carries its live agent
    const run = groups[0].runs[0]
    expect(run.kind === 'task' && run.agent?.id).toBe('a1')
  })
  it('drops empty groups and orders needs → running → idle → done', () => {
    const groups = groupRuns(
      [task({ id: 'td', col: 'done' }), task({ id: 'tr', col: 'review' })],
      [agent({ id: 'a1', status: 'running' })],
    )
    expect(groups.map(g => g.id)).toEqual(['needs', 'running', 'done'])
  })
})
