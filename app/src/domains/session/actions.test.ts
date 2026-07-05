import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSessionActions } from './actions'
import type { SessionActionsCtx } from './actions'
import type { SessionProcessPort, TerminalHandle } from './ports'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { AppState, Agent, AgentType } from '../../core/types'

const liveStateRef = { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Worker', short: 'WO', color: '#fff', repo: 'repo', branch: 'live',
  status: 'running', model: 'mycli', kind: 'real', cmd: 'mycli run', cwd: '/repo', launchedAt: 1,
  log: [{ t: 'sys', x: 'started' }], memory: [], tools: [],
  ...over,
} as unknown as Agent)

function fakePort(over: Partial<SessionProcessPort> = {}): SessionProcessPort {
  return {
    isTauri: false,
    spawnSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    removeSession: vi.fn(async () => {}),
    writeSession: vi.fn(async () => {}),
    sendLine: vi.fn(),
    detectCliSession: vi.fn(async () => null),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    restoreTerminalModes: vi.fn(),
    resetTerminal: vi.fn(),
    attachTerminal: vi.fn((): TerminalHandle => ({ writeln: vi.fn() })),
    disposeTerminal: vi.fn(),
    ...over,
  }
}

function ctx(port: SessionProcessPort, over: Partial<SessionActionsCtx> = {}): SessionActionsCtx {
  return {
    stateRef: liveStateRef,
    flash: vi.fn(),
    logEvent: vi.fn(),
    markUserStopped: vi.fn(),
    disposeSessionRuntime: vi.fn(),
    launchSession: vi.fn(() => 'new-id'),
    probeCliSession: vi.fn(),
    armResponseWatch: vi.fn(),
    appendTail: vi.fn(),
    clearNeeds: vi.fn(),
    bumpSettle: vi.fn(),
    port,
    ...over,
  }
}

function seed(agents: Agent[], over: Partial<AppState> = {}) {
  useAppStore.setState({
    agents, agentTypes: [], activeWorkspace: 'ws', tasks: [],
    groups: [], activeGroup: null, minimizedIds: [], drawer: null, panel: null,
    ...over,
  } as Partial<AppState> as AppState)
}

const get = (id: string) => useAppStore.getState().agents.find(a => a.id === id)

beforeEach(() => seed([agent()]))

describe('createSessionActions', () => {
  it('archiveSession kills a running session, disposes its runtime, and archives it', () => {
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).archiveSession('a1')
    expect(c.markUserStopped).toHaveBeenCalledWith('a1')
    expect(port.killSession).toHaveBeenCalledWith('a1')
    expect(c.disposeSessionRuntime).toHaveBeenCalledWith('a1')
    expect(get('a1')).toMatchObject({ archived: true, status: 'idle' })
  })

  it('archiveSession does not kill an already-idle session', () => {
    seed([agent({ status: 'idle' })])
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).archiveSession('a1')
    expect(port.killSession).not.toHaveBeenCalled()
    expect(c.disposeSessionRuntime).toHaveBeenCalledWith('a1') // still frees the runtime
    expect(get('a1')?.archived).toBe(true)
  })

  it('deleteSession kills, disposes the runtime, removes the file, and drops it from state', () => {
    seed([agent()], { tasks: [{ id: 't1', title: 't', col: 'progress', agentId: 'a1' }] as unknown as AppState['tasks'] })
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).deleteSession('a1')
    expect(port.killSession).toHaveBeenCalledWith('a1')
    expect(c.disposeSessionRuntime).toHaveBeenCalledWith('a1')
    expect(port.removeSession).toHaveBeenCalledWith('a1')
    expect(get('a1')).toBeUndefined()
    expect(useAppStore.getState().tasks[0].agentId).toBeNull() // task unbound from the deleted session
  })

  it('stopSession kills the PTY and marks the session idle+stopped', () => {
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).stopSession('a1')
    expect(c.markUserStopped).toHaveBeenCalledWith('a1')
    expect(port.killSession).toHaveBeenCalledWith('a1')
    const a = get('a1')
    expect(a?.status).toBe('idle')
    expect(a?.log.at(-1)?.x).toContain('stopped by you')
  })

  it('resume respawns via the CLI resume command and marks the session running', () => {
    const type = { id: 'cli', name: 'CLI', model: 'mycli', resumeCmd: 'mycli --resume {id}' } as unknown as AgentType
    seed([agent({ status: 'idle', cliSessionId: 'sid-9', typeId: 'cli' })], { agentTypes: [type] })
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).resume('a1')
    expect(port.spawnSession).toHaveBeenCalledWith('a1', expect.stringContaining('mycli --resume sid-9'), '/repo', undefined, undefined, undefined)
    expect(c.probeCliSession).toHaveBeenCalledWith('a1', 'mycli --resume sid-9', '/repo', true)
    expect(get('a1')?.status).toBe('running')
  })

  // a corrupted terminal (alt screen / mouse modes left by a Ctrl+C-killed
  // TUI) must never leak into the resumed process
  it('resume fully resets the reused xterm BEFORE respawning', () => {
    seed([agent({ status: 'error' })])
    const port = fakePort()
    const order: string[] = []
    vi.mocked(port.resetTerminal).mockImplementation(() => { order.push('reset') })
    vi.mocked(port.spawnSession).mockImplementation(async () => { order.push('spawn') })
    createSessionActions(ctx(port)).resume('a1')
    expect(order).toEqual(['reset', 'spawn'])
  })

  it('resume is a no-op for a chat agent (no process)', () => {
    seed([agent({ kind: 'chat', status: 'idle' })])
    const port = fakePort()
    createSessionActions(ctx(port)).resume('a1')
    expect(port.spawnSession).not.toHaveBeenCalled()
  })

  it('sendInput echoes the line, arms the watcher, and writes to the PTY', () => {
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).sendInput('a1', 'hello')
    expect(c.armResponseWatch).toHaveBeenCalledWith('a1')
    expect(port.sendLine).toHaveBeenCalledWith('a1', 'hello')
    expect(get('a1')?.log.at(-1)).toMatchObject({ t: 'you', x: 'hello' })
  })

  it('unarchiveSession rebuilds the terminal and replays the retained log', () => {
    seed([agent({ archived: true, status: 'idle', log: [{ t: 'sys', x: 'line one' }] })])
    const writeln = vi.fn()
    const port = fakePort({ attachTerminal: vi.fn(() => ({ writeln })) })
    createSessionActions(ctx(port)).unarchiveSession('a1')
    expect(port.disposeTerminal).toHaveBeenCalledWith('a1')
    expect(port.attachTerminal).toHaveBeenCalledOnce()
    expect(writeln).toHaveBeenCalledWith(expect.stringContaining('line one'))
    expect(get('a1')?.archived).toBeFalsy()
  })
})
