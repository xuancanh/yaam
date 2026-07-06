import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createLaunchRuntime } from './launch-runtime'
import type { LaunchRuntimeCtx } from './launch-runtime'
import type { SessionProcessPort } from './ports'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { AppState, AgentType } from '../../core/types'

const agentType = (over: Partial<AgentType> = {}): AgentType =>
  ({ id: 'cli', name: 'CLI', model: 'mycli', enabled: true, ...over } as unknown as AgentType)

// A live ref that always reads the current store state (mirrors the provider's
// subscribe-maintained stateRef, without needing React).
const liveStateRef = { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>

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
    detachedSpawn: vi.fn(async () => 'attach-cmd'),
    detachedKill: vi.fn(async () => {}),
    restoreTerminalModes: vi.fn(),
    quiesceTerminal: vi.fn(),
    repaintTerminal: vi.fn(),
    terminalSize: vi.fn(() => ({ rows: 48, cols: 190 })),
    resetTerminal: vi.fn(),
    attachTerminal: vi.fn(() => ({ writeln: vi.fn() })),
    disposeTerminal: vi.fn(),
    isAltScreen: vi.fn(() => false),
    ...over,
  }
}

function ctx(port: SessionProcessPort, over: Partial<LaunchRuntimeCtx> = {}): LaunchRuntimeCtx {
  return {
    stateRef: liveStateRef,
    later: vi.fn(),
    flash: vi.fn(),
    logEvent: vi.fn(),
    appendTail: vi.fn(),
    clearNeeds: vi.fn(),
    bumpSettle: vi.fn(),
    armResponseWatch: vi.fn(),
    pushTaskChat: vi.fn(),
    runWatcher: vi.fn(),
    taskSessions: { current: new Map() },
    port,
    ...over,
  }
}

beforeEach(() => {
  useAppStore.setState({
    agents: [], agentTypes: [agentType()], activeWorkspace: 'ws',
    settings: { shell: 'zsh' } as AppState['settings'],
    groups: [], activeGroup: null, minimizedIds: [], newSessionOpen: true,
  } as Partial<AppState> as AppState)
})

describe('createLaunchRuntime.launchSession', () => {
  it('inserts an optimistic running session, attaches its terminal, and spawns the PTY', async () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Worker', 'cli', undefined, { ephemeral: true })
    expect(id).not.toBeNull()
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent).toMatchObject({ status: 'running', name: 'Worker', ephemeral: true })
    expect(port.attachTerminal).toHaveBeenCalledWith(id, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function))
    expect(port.spawnSession).toHaveBeenCalledWith(id, expect.stringContaining('mycli run'), '/repo', undefined, undefined, undefined, 'zsh')
    await Promise.resolve()
    expect(useAppStore.getState().agents.find(a => a.id === id)?.status).toBe('running')
  })

  it('launches a plain terminal directly without a command-shell wrapper', () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('zsh -i', '/repo', 'Terminal', undefined, undefined, { terminalShell: 'zsh' })
    expect(port.spawnSession).toHaveBeenCalledWith(id, 'zsh -i', '/repo', undefined, undefined, 'zsh', undefined)
  })

  it('rolls the session into an error state when the PTY spawn rejects', async () => {
    const port = fakePort({ spawnSession: vi.fn(async () => { throw new Error('spawn failed: no shell') }) })
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Worker', 'cli')
    expect(id).not.toBeNull()
    // optimistic state is running until the rejection is observed
    expect(useAppStore.getState().agents.find(a => a.id === id)?.status).toBe('running')
    await Promise.resolve()
    await Promise.resolve()
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent?.status).toBe('error')
    expect(agent?.log.some(l => l.t === 'err' && l.x.includes('spawn failed'))).toBe(true)
  })

  it('returns null for a blank command and never spawns', () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    expect(rt.launchSession('   ', '/repo')).toBeNull()
    expect(port.spawnSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().agents).toHaveLength(0)
  })

  it('isolate: builds the worktree first, then spawns inside its workdir', async () => {
    const port = fakePort({
      createWorktree: vi.fn(async (base: string, slug: string) => ({
        root: `/home/.yaam/worktrees/${slug}`, base, slug,
        workdir: `/home/.yaam/worktrees/${slug}/repo`,
        repos: [{ name: 'repo', source: base, branch: `yaam/${slug}`, base_ref: 'main' }],
      })),
    })
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Iso', 'cli', undefined, { isolate: true })!
    expect(port.createWorktree).toHaveBeenCalledWith('/repo', id)
    await Promise.resolve()
    await Promise.resolve()
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent?.cwd).toBe(`/home/.yaam/worktrees/${id}/repo`)
    expect(agent?.worktree?.root).toBe(`/home/.yaam/worktrees/${id}`)
    expect(port.spawnSession).toHaveBeenCalledWith(id, expect.any(String), `/home/.yaam/worktrees/${id}/repo`, undefined, undefined, undefined, 'zsh')
  })

  it('isolate: a worktree failure marks the session errored without spawning', async () => {
    const port = fakePort({ createWorktree: vi.fn(async () => { throw new Error('no git repository found') }) })
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/plain-folder', 'Iso', 'cli', undefined, { isolate: true })!
    await Promise.resolve()
    await Promise.resolve()
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent?.status).toBe('error')
    expect(port.spawnSession).not.toHaveBeenCalled()
  })

  it('focuses a launch in the active workspace but leaves background launches alone', () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    rt.launchSession('mycli run', '/repo', 'Bg', 'cli', 'other-ws')
    // a background-workspace launch must not clear the active new-session UI
    expect(useAppStore.getState().newSessionOpen).toBe(true)
    rt.launchSession('mycli run', '/repo', 'Fg', 'cli', 'ws')
    expect(useAppStore.getState().newSessionOpen).toBe(false)
  })
})

describe('detached launches', () => {
  it('spawns the attach client from detachedSpawn and marks the agent detached', async () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('sleep 999', '/repo', undefined, undefined, undefined, { detached: true })
    expect(id).toBeTruthy()
    await Promise.resolve(); await Promise.resolve()
    expect(port.detachedSpawn).toHaveBeenCalledWith(id, expect.stringContaining('sleep 999'), '/repo', 'zsh')
    expect(port.spawnSession).toHaveBeenCalledWith(id, 'attach-cmd', '/repo', undefined, undefined, undefined, undefined)
    const a = useAppStore.getState().agents.find(x => x.id === id)
    expect(a?.detached).toBe(true)
    expect(a?.cmd).toBe('attach-cmd') // resume = reattach
  })
})
