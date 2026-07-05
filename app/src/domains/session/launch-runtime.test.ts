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
    detectCliSession: vi.fn(async () => null),
    attachTerminal: vi.fn(),
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
    expect(port.spawnSession).toHaveBeenCalledWith(id, expect.stringContaining('mycli run'), '/repo', undefined, undefined, undefined)
    await Promise.resolve()
    expect(useAppStore.getState().agents.find(a => a.id === id)?.status).toBe('running')
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
