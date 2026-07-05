import { describe, expect, it } from 'vitest'
import { buildRemoteSnapshot } from './snapshot'
import type { AppState, Agent, BoardTask, ChatMsg, TaskChatMsg } from '../../core/types'

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
  it('splits sessions and chats, includes screens, task chats, and both approval kinds', () => {
    const chatLog: ChatMsg[] = [
      { id: 'm0', role: 'thinking', text: 'hmm', at: 0 },
      { id: 'm1', role: 'assistant', text: 'run rm -rf dist?', at: 1, approval: 'pending' },
      { id: 'm2', role: 'user', text: 'sure', at: 2 },
    ]
    const taskChat: TaskChatMsg[] = [{ id: 'tc1', role: 'watcher', text: 'tests green', at: 3 }]
    const s = state({
      agents: [
        agent({ id: 'a1', task: 'auth refactor', summary: 'tests green', actionNeeded: 'review PR' }),
        agent({ id: 'a2', name: 'helper', kind: 'chat', chatLog, chatModel: 'sonnet-4' }),
        agent({ id: 'a3', archived: true }),
        agent({ id: 'a4', name: 'elsewhere', workspaceId: 'w2' }),
      ],
      tasks: [
        task({ id: 't1', col: 'review', watcherNote: 'awaiting review', awaitingUser: true, chat: taskChat, description: 'desc', criteria: ['c1'] }),
        task({ id: 't2', col: 'backlog' }),
        task({ id: 't4', col: 'progress', archived: true }),
      ],
      pendingToolApprovals: [{ id: 'ap1', toolId: 'run_shell' }],
    })
    const snap = buildRemoteSnapshot(s, id => (id === 'a1' ? { data: '\x1b[32m$ npm test\x1b[0m ok', cols: 190 } : { data: '', cols: 80 }))

    expect(snap.workspace).toBe('acme')
    // sessions: real agents only, with their terminal tail; archived excluded
    expect(snap.sessions.map(x => x.id)).toEqual(['a1']) // archived + other-workspace excluded
    expect(snap.sessions[0]).toMatchObject({ task: 'auth refactor', cost: 1.25, cols: 190 })
    expect(snap.sessions[0].term).toContain('npm test') // serialized ANSI, colors kept

    // chats carry recent messages, thinking excluded
    expect(snap.chats.map(c => c.id)).toEqual(['a2'])
    expect(snap.chats[0].model).toBe('sonnet-4')
    expect(snap.chats[0].msgs.map(m => m.id)).toEqual(['m1', 'm2'])

    // the WHOLE board (backlog too), minus archived, with watcher chat attached
    expect(snap.tasks.map(t => t.id)).toEqual(['t1', 't2'])
    expect(snap.tasks[0]).toMatchObject({ col: 'review', awaitingUser: true, description: 'desc', criteria: ['c1'] })
    expect(snap.tasks[0].chat).toEqual([{ id: 'tc1', role: 'watcher', text: 'tests green', at: 3 }])

    expect(snap.approvals).toEqual([
      expect.objectContaining({ kind: 'master', id: 'ap1', label: 'Master wants "run_shell"' }),
      expect.objectContaining({ kind: 'chat', id: 'm1', agentId: 'a2', detail: 'run rm -rf dist?' }),
    ])
  })

  it('produces an empty but well-formed snapshot for a quiet fleet', () => {
    const snap = buildRemoteSnapshot(state({}))
    expect(snap.sessions).toEqual([])
    expect(snap.tasks).toEqual([])
    expect(snap.chats).toEqual([])
    expect(snap.approvals).toEqual([])
    expect(typeof snap.ts).toBe('number')
  })

  it('caps message and screen payloads so snapshots stay small', () => {
    const chatLog: ChatMsg[] = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: 'x'.repeat(5000), at: i }))
    const s = state({ agents: [agent({ id: 'c1', kind: 'chat', chatLog })] })
    const snap = buildRemoteSnapshot(s, () => ({ data: '', cols: 80 }))
    expect(snap.chats[0].msgs.length).toBe(30)
    expect(snap.chats[0].msgs[0].text.length).toBeLessThanOrEqual(4001)
  })
})
