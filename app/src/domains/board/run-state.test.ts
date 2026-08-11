import { describe, expect, it } from 'vitest'
import { groupRuns, groupRunsByFolder, runGroupOf, runMatchesFilter, runNeedsUserAction, runStatusLabel } from './run-state'
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
  it('treats monitor actions and failures as user-action rows', () => {
    const action = { kind: 'session' as const, key: 'sess:a1', agent: agent({ status: 'running', actionNeeded: 'Approve the command' }) }
    expect(runNeedsUserAction(action)).toBe(true)
    expect(runGroupOf(action)).toBe('needs')
    expect(runStatusLabel(action)).toEqual({ label: 'action needed', tone: 'amber' })

    const failed = { kind: 'task' as const, key: 'task:t1', task: task({ col: 'failed' }) }
    expect(runNeedsUserAction(failed)).toBe(true)
    expect(runGroupOf(failed)).toBe('needs')
    expect(runStatusLabel(failed)).toEqual({ label: 'failed', tone: 'red' })
  })
  it('live agents run, unstarted backlog tasks are startable, finished tasks are done, and ordinary rows stay compact', () => {
    expect(runGroupOf({ kind: 'session', key: 'sess:a1', agent: agent({ status: 'running' }) })).toBe('running')
    expect(runGroupOf({ kind: 'task', key: 'task:t1', task: task({ col: 'done' }) })).toBe('done')
    expect(runGroupOf({ kind: 'task', key: 'task:t1', task: task({ col: 'backlog' }) })).toBe('backlog')
    expect(runGroupOf({ kind: 'session', key: 'sess:a1', agent: agent({ status: 'idle' }) })).toBe('idle')
    expect(runNeedsUserAction({ kind: 'session', key: 'sess:a1', agent: agent({ status: 'running' }) })).toBe(false)
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
  it('keeps additional task sessions visible after the primary session changes', () => {
    const primary = agent({ id: 'primary', status: 'running' })
    const earlier = agent({ id: 'earlier', status: 'idle' })
    const t1 = task({ id: 't1', agentId: 'primary', agentIds: ['earlier', 'primary'] })

    const keys = groupRuns([t1], [primary, earlier]).flatMap(g => g.runs.map(r => r.key))

    expect(keys).toEqual(['task:t1', 'sess:earlier'])
  })
  it('drops empty groups and orders needs → running → idle → done', () => {
    const groups = groupRuns(
      [task({ id: 'td', col: 'done' }), task({ id: 'tr', col: 'review' })],
      [agent({ id: 'a1', status: 'running' })],
    )
    expect(groups.map(g => g.id)).toEqual(['needs', 'running', 'done'])
  })
  it('keeps task and loose-session agents inside the active workspace', () => {
    const local = agent({ id: 'local', workspaceId: 'ws-a' })
    const remote = agent({ id: 'remote', workspaceId: 'ws-b', status: 'running' })
    const untagged = agent({ id: 'legacy', workspaceId: undefined })
    const groups = groupRuns(
      [task({ id: 't1', agentId: 'remote' })],
      [local, remote, untagged],
      'all',
      'ws-a',
    )
    const runs = groups.flatMap(g => g.runs)
    expect(runs.map(r => r.key)).toEqual(['task:t1', 'sess:local', 'sess:legacy'])
    expect(runs.find(r => r.key === 'task:t1')).toMatchObject({ agent: undefined })
  })
})

describe('groupRunsByFolder', () => {
  it('buckets runs by working folder in triage order, folderless last', () => {
    const urgent = agent({ id: 'urgent', status: 'needs', cwd: '/repos/api/' })
    const calm = agent({ id: 'calm', status: 'running', cwd: '/repos/web' })
    const nowhere = agent({ id: 'nowhere', status: 'idle' })
    const groups = groupRunsByFolder([], [calm, urgent, nowhere])
    expect(groups.map(g => g.cwd)).toEqual(['/repos/api', '/repos/web', ''])
    expect(groups.map(g => g.label)).toEqual(['api', 'web', 'No folder'])
    expect(groups[0].runs.map(r => r.key)).toEqual(['sess:urgent'])
  })
  it('attaches archived sessions to their folder, including archive-only folders', () => {
    const live = agent({ id: 'live', status: 'running', cwd: '/repos/api' })
    const old1 = agent({ id: 'old1', archived: true, cwd: '/repos/api/' })
    const old2 = agent({ id: 'old2', archived: true, cwd: '/repos/legacy' })
    const chat = agent({ id: 'chat', kind: 'chat', archived: true, cwd: '/repos/api' })
    const groups = groupRunsByFolder([], [live, old1, old2, chat])
    expect(groups.map(g => g.cwd)).toEqual(['/repos/api', '/repos/legacy'])
    expect(groups[0].archived.map(a => a.id)).toEqual(['old1'])
    expect(groups[0].runs.map(r => r.key)).toEqual(['sess:live'])
    expect(groups[1].runs).toEqual([])
    expect(groups[1].archived.map(a => a.id)).toEqual(['old2'])
  })
  it('prefers the worktree folder and scopes archived sessions to the workspace', () => {
    const wt = agent({ id: 'wt', status: 'running', cwd: '/repos/api', worktree: { workdir: '/wt/api-fix' } as never })
    const foreign = agent({ id: 'foreign', archived: true, cwd: '/repos/api', workspaceId: 'ws-b' })
    const groups = groupRunsByFolder([], [wt, foreign], 'all', 'ws-a')
    expect(groups.map(g => g.cwd)).toEqual(['/wt/api-fix'])
    expect(groups[0].archived).toEqual([])
  })
})
