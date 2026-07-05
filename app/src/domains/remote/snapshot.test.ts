import { describe, expect, it } from 'vitest'
import { buildRemoteSnapshot } from './snapshot'
import type { AppState, Agent, BoardTask, ChatMsg } from '../../core/types'

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: 'a1', name: 'refactor', short: 'RF', color: '#fff', repo: 'yaam', branch: 'main',
    status: 'running', model: 'sonnet', memory: [], tools: [], log: [], used: 0,
    cost: 1.25, budget: 10, snaps: [], diff: [],
    ...over,
  }) as Agent

const task = (over: Partial<BoardTask>): BoardTask =>
  ({ id: 't1', title: 'Fix login', col: 'progress', ...over }) as BoardTask

const state = (over: Partial<AppState>): AppState =>
  ({
    agents: [], tasks: [], pendingToolApprovals: [], workspaces: [{ id: 'w1', name: 'acme' }],
    activeWorkspace: 'w1',
    ...over,
  }) as unknown as AppState

describe('buildRemoteSnapshot', () => {
  it('collects sessions, watched tasks, and both approval kinds', () => {
    const chatLog: ChatMsg[] = [
      { id: 'm1', role: 'assistant', text: 'run rm -rf dist?', at: 1, approval: 'pending' },
      { id: 'm2', role: 'assistant', text: 'done earlier', at: 2, approval: 'approved' },
    ]
    const s = state({
      agents: [
        agent({ id: 'a1', task: 'auth refactor', summary: 'tests green', actionNeeded: 'review PR' }),
        agent({ id: 'a2', name: 'helper', kind: 'chat', chatLog }),
        agent({ id: 'a3', archived: true }),
      ],
      tasks: [
        task({ id: 't1', col: 'review', watcherNote: 'awaiting review', awaitingUser: true }),
        task({ id: 't2', col: 'backlog' }),
        task({ id: 't3', col: 'done' }),
        task({ id: 't4', col: 'progress', archived: true }),
      ],
      pendingToolApprovals: [{ id: 'ap1', toolId: 'run_shell' }],
    })
    const snap = buildRemoteSnapshot(s)

    expect(snap.workspace).toBe('acme')
    expect(snap.sessions.map(x => x.id)).toEqual(['a1', 'a2']) // archived excluded
    expect(snap.sessions[0]).toMatchObject({ task: 'auth refactor', actionNeeded: 'review PR', cost: 1.25 })

    // only live board columns; backlog/done/archived stay off the phone
    expect(snap.tasks.map(t => t.id)).toEqual(['t1'])
    expect(snap.tasks[0]).toMatchObject({ col: 'review', awaitingUser: true })

    expect(snap.approvals).toEqual([
      expect.objectContaining({ kind: 'master', id: 'ap1', label: 'Master wants "run_shell"' }),
      expect.objectContaining({ kind: 'chat', id: 'm1', agentId: 'a2', detail: 'run rm -rf dist?' }),
    ])
  })

  it('produces an empty but well-formed snapshot for a quiet fleet', () => {
    const snap = buildRemoteSnapshot(state({}))
    expect(snap.sessions).toEqual([])
    expect(snap.tasks).toEqual([])
    expect(snap.approvals).toEqual([])
    expect(typeof snap.ts).toBe('number')
  })
})
