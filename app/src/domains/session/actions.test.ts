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
    sandboxWrapper: vi.fn(async () => "sandbox-exec -f '/fake.sb'"),
    detachedSpawn: vi.fn(async () => 'attach-cmd'),
    detachedKill: vi.fn(async () => {}),
    restoreTerminalModes: vi.fn(),
    quiesceTerminal: vi.fn(),
    repaintTerminal: vi.fn(),
    terminalSize: vi.fn(() => ({ rows: 48, cols: 190 })),
    resetTerminal: vi.fn(),
    isAltScreen: vi.fn(() => false),
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
    expect(port.spawnSession).toHaveBeenCalledWith('a1', expect.stringContaining('mycli --resume sid-9'), '/repo', 48, 190, undefined, 'zsh')
    expect(c.probeCliSession).toHaveBeenCalledWith('a1', 'mycli --resume sid-9', '/repo', true)
    expect(get('a1')?.status).toBe('running')
  })

  it('resume ensures the detached host and spawns the returned attach command', async () => {
    const type = { id: 'cli', name: 'CLI', model: 'mycli', env: 'TOKEN=secret', resumeCmd: 'mycli --resume {id}' } as unknown as AgentType
    seed([agent({ status: 'idle', detached: true, cmd: 'mycli run', cliSessionId: 'sid-9', typeId: 'cli' })], { agentTypes: [type] })
    const port = fakePort()
    const c = ctx(port)
    createSessionActions(c).resume('a1')
    await Promise.resolve(); await Promise.resolve()
    // the ORIGINAL command goes to detachedSpawn — a live host reattaches,
    // a dead one is relaunched from this command; never the CLI resume command
    expect(port.detachedSpawn).toHaveBeenCalledWith('a1', expect.stringContaining('mycli run'), '/repo', 'zsh', 48, 190)
    expect(port.spawnSession).toHaveBeenCalledWith('a1', 'attach-cmd', '/repo', 48, 190, undefined, undefined)
    expect(c.probeCliSession).not.toHaveBeenCalled()
    expect(get('a1')?.log.at(-1)?.x).toContain('reattaching detached session')
  })

  it('resume of a legacy detached agent (attach wrapper as cmd) reuses the stored host spec', async () => {
    const attach = '"/Applications/YAAM.app/Contents/MacOS/YAAM" --yaam-attach "/tmp/a1.sock"'
    seed([agent({ status: 'idle', detached: true, cmd: attach })])
    const port = fakePort()
    createSessionActions(ctx(port)).resume('a1')
    await Promise.resolve(); await Promise.resolve()
    // '' tells the backend to relaunch from the host's on-disk spec, which
    // still holds the real command the legacy agent never persisted
    expect(port.detachedSpawn).toHaveBeenCalledWith('a1', '', '/repo', 'zsh', 48, 190)
    expect(port.spawnSession).toHaveBeenCalledWith('a1', 'attach-cmd', '/repo', 48, 190, undefined, undefined)
  })

  it('resume surfaces a detached relaunch failure as a session error', async () => {
    seed([agent({ status: 'idle', detached: true, cmd: 'mycli run' })])
    const port = fakePort({ detachedSpawn: vi.fn(async () => { throw new Error('detached session ended and its command was not recorded') }) })
    createSessionActions(ctx(port)).resume('a1')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(port.spawnSession).not.toHaveBeenCalled()
    expect(get('a1')?.status).toBe('error')
    expect(get('a1')?.log.at(-1)?.x).toContain('not recorded')
  })

  it('resume re-wraps a sandboxed session in a fresh backend wrapper', async () => {
    const type = { id: 'cli', name: 'CLI', model: 'mycli', resumeCmd: 'mycli --resume {id}' } as unknown as AgentType
    seed([agent({ status: 'idle', cliSessionId: 'sid-9', typeId: 'cli', sandbox: { denyNetwork: true, extraPaths: ['/data'] } })], { agentTypes: [type] })
    const port = fakePort()
    createSessionActions(ctx(port)).resume('a1')
    await Promise.resolve(); await Promise.resolve()
    expect(port.sandboxWrapper).toHaveBeenCalledWith('a1', '/repo', ['/data'], true)
    expect(port.spawnSession).toHaveBeenCalledWith('a1', expect.stringMatching(/^sandbox-exec -f '\/fake\.sb' \/bin\/sh -c 'mycli --resume sid-9'/), '/repo', 48, 190, undefined, 'zsh')
  })

  it('resume fails closed when a sandboxed session cannot rebuild its wrapper', async () => {
    seed([agent({ status: 'idle', sandbox: {} })])
    const port = fakePort({ sandboxWrapper: vi.fn(async () => { throw new Error('sandbox: bwrap is not installed') }) })
    createSessionActions(ctx(port)).resume('a1')
    await Promise.resolve(); await Promise.resolve()
    expect(port.spawnSession).not.toHaveBeenCalled()
    expect(get('a1')?.status).toBe('error')
    expect(get('a1')?.log.at(-1)?.x).toContain('bwrap')
  })

  it('resume of a sandboxed machine session re-enters the remote bwrap wrap', async () => {
    const machine = { id: 'm1', label: 'Box', host: 'box.test', user: 'u' } as unknown as Agent['machine']
    seed([agent({ status: 'idle', machineId: 'm1', machine, sandbox: {}, cwd: '/home/u/proj' })])
    const port = fakePort()
    createSessionActions(ctx(port)).resume('a1')
    expect(port.sandboxWrapper).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(port.spawnSession).toHaveBeenCalled())
    const cmd = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    const b64 = /printf %s (\S+) \| base64 -d/.exec(cmd)?.[1]
    expect(b64).toBeTruthy()
    expect(atob(b64!)).toContain('set -- bwrap --ro-bind / /')
    expect(atob(b64!)).toContain('exec "$@" sh -c')
  })

  it('surfaces an invalid remote sandbox policy instead of throwing or spawning', async () => {
    const machine = { id: 'm1', label: 'Box', host: 'box.test', user: 'u' } as unknown as Agent['machine']
    seed([agent({ status: 'idle', machineId: 'm1', machine, sandbox: {}, cwd: 'relative/path' })])
    const port = fakePort()
    expect(() => createSessionActions(ctx(port)).resume('a1')).not.toThrow()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(port.spawnSession).not.toHaveBeenCalled()
    expect(get('a1')?.status).toBe('error')
    expect(get('a1')?.log.at(-1)?.x).toContain('absolute path')
  })

  it('surfaces a remote sandbox spawn failure on the session', async () => {
    const machine = { id: 'm1', label: 'Box', host: 'box.test', user: 'u' } as unknown as Agent['machine']
    seed([agent({ status: 'idle', machineId: 'm1', machine, sandbox: {}, cwd: '/repo' })])
    const port = fakePort({ spawnSession: vi.fn(async () => { throw new Error('ssh unavailable') }) })
    createSessionActions(ctx(port)).resume('a1')
    await vi.waitFor(() => expect(get('a1')?.status).toBe('error'))
    expect(get('a1')?.log.at(-1)?.x).toContain('ssh unavailable')
  })

  // resume NEVER wipes the scrollback automatically — the regression was an
  // unconditional reset clearing healthy history. Modes are re-normalized and
  // a corrupted (alt-screen) death only WARNS, pointing at Clear terminal.
  it('resume restores modes and preserves the scrollback', () => {
    seed([agent({ status: 'idle' })])
    const port = fakePort() // isAltScreen defaults to false
    createSessionActions(ctx(port)).resume('a1')
    expect(port.resetTerminal).not.toHaveBeenCalled()
    expect(port.restoreTerminalModes).toHaveBeenCalledWith('a1')
    expect(port.spawnSession).toHaveBeenCalled()
    expect(get('a1')?.log.at(-1)?.x).not.toContain('Clear terminal')
  })

  it('resume after a mid-render TUI death keeps the buffer but warns about Clear terminal', () => {
    seed([agent({ status: 'error' })])
    const port = fakePort({ isAltScreen: vi.fn(() => true) })
    createSessionActions(ctx(port)).resume('a1')
    expect(port.resetTerminal).not.toHaveBeenCalled()
    expect(port.restoreTerminalModes).toHaveBeenCalledWith('a1')
    expect(get('a1')?.log.at(-1)?.x).toContain('Clear terminal')
  })

  it('resume syncs the PTY size and nudges a repaint once the respawn settles', async () => {
    vi.useFakeTimers()
    seed([agent({ status: 'idle' })])
    const port = fakePort()
    createSessionActions(ctx(port)).resume('a1')
    await Promise.resolve() // let the spawn promise settle
    expect(port.repaintTerminal).not.toHaveBeenCalled() // waits for the CLI to boot
    await vi.advanceTimersByTimeAsync(500)
    expect(port.repaintTerminal).toHaveBeenCalledWith('a1')
    vi.useRealTimers()
  })

  it('refreshTerminal is the explicit user reset: restore modes, then wipe', () => {
    const port = fakePort()
    const order: string[] = []
    vi.mocked(port.restoreTerminalModes).mockImplementation(() => { order.push('restore') })
    vi.mocked(port.resetTerminal).mockImplementation(() => { order.push('reset') })
    createSessionActions(ctx(port)).refreshTerminal('a1')
    expect(order).toEqual(['restore', 'reset'])
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
    expect(get('a1')?.history?.[0]).toMatchObject({ actor: 'user', kind: 'send', detail: 'hello' })
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
    const submit = vi.mocked(port.attachTerminal).mock.calls[0][4]
    submit('typed directly')
    expect(get('a1')?.history?.[0]).toMatchObject({ actor: 'user', text: 'Submitted terminal input' })
    expect(get('a1')?.history?.[0]?.detail).toBe('typed directly')
  })
})
