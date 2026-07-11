import { describe, expect, it } from 'vitest'
import { buildRemoteSnapshot, masterMsgText } from './snapshot'
import type { AppState, Agent, BoardTask, ChatMsg, Message, TaskChatMsg } from '../../core/types'

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
    activeWorkspace: 'w1', messages: [], masterBusy: false,
    settings: { masterEnabled: false, apiKey: '', credCmd: '', provider: 'anthropic' },
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
      durableAgents: [
        { id: 'agent-default', name: 'Assistant', color: '#7FD1FF', charter: '', builtin: true, createdAt: 0 },
        { id: 'da1', name: 'Researcher', color: '#B692F6', role: 'digs things up', charter: '', createdAt: 1 },
        { id: 'da2', name: 'Gone', color: '#fff', charter: '', archived: true, createdAt: 2 },
      ],
      agents: [
        agent({ id: 'a1', task: 'auth refactor', summary: 'tests green', actionNeeded: 'review PR', attention: true }),
        agent({ id: 'a2', name: 'helper', kind: 'chat', cwd: '/chat/root', chatLog, chatModel: 'sonnet-4', durableAgentId: 'da1', chatPinned: true }),
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
    expect(snap.workspaceId).toBe('w1')
    expect(snap.workspaces).toEqual([{ id: 'w1', name: 'acme' }])
    // sessions: real agents only, with their terminal tail; archived excluded
    expect(snap.sessions.map(x => x.id)).toEqual(['a1']) // archived + other-workspace excluded
    expect(snap.sessions[0]).toMatchObject({ task: 'auth refactor', cost: 1.25, cols: 190, attention: true })
    expect(snap.sessions[0].term).toContain('npm test') // serialized ANSI, colors kept

    // chats carry recent messages, thinking excluded; durable grouping metadata
    expect(snap.chats.map(c => c.id)).toEqual(['a2'])
    expect(snap.chats[0].model).toBe('sonnet-4')
    expect(snap.chats[0].msgs.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(snap.chats[0]).toMatchObject({ durableAgentId: 'da1', cwd: '/chat/root', pinned: true, busy: true, lastAt: 2 })

    // archived durable agents are excluded
    expect(snap.durables.map(d => d.id)).toEqual(['agent-default', 'da1'])
    expect(snap.durables[1]).toMatchObject({ name: 'Researcher', role: 'digs things up', builtin: false })

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
    expect(snap.durables).toEqual([])
    expect(snap.approvals).toEqual([])
    expect(snap.master).toEqual({ busy: false, brain: false, msgs: [] })
    expect(typeof snap.ts).toBe('number')
  })

  it('carries the Master conversation, mapping roles and skipping empty structured messages', () => {
    const messages: Message[] = [
      { id: 'm1', role: 'master', kind: 'text', text: 'Hi, I am Master.' },
      { id: 'm2', role: 'you', kind: 'text', text: 'launch a session' },
      { id: 'm3', role: 'master', kind: 'route', text: '', routes: [{ name: 'worker', color: '#fff', repo: 'yaam', task: 'x', action: 'launch' }] },
      { id: 'm4', role: 'master', kind: 'buildui', text: '' },
    ]
    const snap = buildRemoteSnapshot(state({ masterBusy: true, messages, settings: { masterEnabled: true, apiKey: 'k', credCmd: '', provider: 'anthropic' } as AppState['settings'] }))
    expect(snap.master.busy).toBe(true)
    expect(snap.master.brain).toBe(true)
    expect(snap.master.msgs.map(m => m.role)).toEqual(['assistant', 'user', 'assistant', 'assistant'])
    expect(snap.master.msgs[0].text).toBe('Hi, I am Master.')
    expect(snap.master.msgs[2].kind).toBe('route')
    expect(snap.master.msgs[2].routes?.[0]?.name).toBe('worker')
    expect(snap.master.msgs[2].text).toBe('') // mobile renders the structured route card, not a synthetic line
  })

  it('masterMsgText flattens structured payloads to a readable line', () => {
    expect(masterMsgText({ id: 'x', role: 'master', kind: 'text', text: 'plain' })).toBe('plain')
    expect(masterMsgText({ id: 'x', role: 'master', kind: 'escalate', esc: { name: 'w', color: '#fff', repo: 'r', reason: 'need input', resolved: false, decision: null } })).toContain('need input')
    expect(masterMsgText({ id: 'x', role: 'master', kind: 'buildui' })).toBe('Built a view')
  })

  it('caps message and screen payloads so snapshots stay small', () => {
    const chatLog: ChatMsg[] = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: 'x'.repeat(5000), at: i }))
    const s = state({ agents: [agent({ id: 'c1', kind: 'chat', chatLog })] })
    const snap = buildRemoteSnapshot(s, () => ({ data: '', cols: 80 }))
    expect(snap.chats[0].msgs.length).toBe(30)
    expect(snap.chats[0].msgs[0].text.length).toBeLessThanOrEqual(4001)
    // an unclaimed chat falls to the built-in generic agent
    expect(snap.chats[0].durableAgentId).toBe('agent-default')
  })
})
