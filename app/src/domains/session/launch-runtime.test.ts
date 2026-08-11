import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createLaunchRuntime } from './launch-runtime'
import type { LaunchRuntimeCtx } from './launch-runtime'
import type { SessionProcessPort } from './ports'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { AgentTemplate, AppState, AgentType, BoardTask, Machine } from '../../core/types'

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
    detectCliSession: vi.fn(async () => null), hooksInfo: vi.fn(async () => null), installKiroHooks: vi.fn(async () => {}), watchTranscript: vi.fn(async () => {}), unwatchTranscript: vi.fn(async () => {}), freePort: vi.fn(async () => null), watchOpencode: vi.fn(async () => {}), unwatchOpencode: vi.fn(async () => {}), acpStart: vi.fn(async () => {}), acpStop: vi.fn(async () => {}),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    sandboxWrapper: vi.fn(async () => "sandbox-exec -f '/fake.sb'"),
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

  it('wires Claude lifecycle hooks to the local listener via --settings', async () => {
    const port = fakePort({ hooksInfo: vi.fn(async () => ({ port: 43210, token: 'tok' })) })
    useAppStore.setState({ agentTypes: [agentType({ id: 'claude', model: 'claude', probe: 'claude' })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('claude', '/repo', 'C', 'claude')!
    await Promise.resolve()
    await Promise.resolve()
    const spawned = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(spawned).toContain('--settings')
    expect(spawned).toContain(`http://127.0.0.1:43210/hook?token=tok&agent=${id}`)
    expect(spawned).toContain('"PreToolUse"')
    // the durable record keeps the CLEAN command for relaunch/resume
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent?.cmd).toBe('claude')
    // minted id → the transcript tail starts immediately at the known path
    expect(port.watchTranscript).toHaveBeenCalledWith(id, 'claude', '/repo', agent?.cliSessionId, false)
  })

  it('skips hook injection when the listener is unavailable or the user passed --settings', async () => {
    const port = fakePort({ hooksInfo: vi.fn(async () => null) })
    useAppStore.setState({ agentTypes: [agentType({ id: 'claude', model: 'claude', probe: 'claude' })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port))
    rt.launchSession('claude', '/repo', 'C', 'claude')
    await Promise.resolve()
    await Promise.resolve()
    expect((port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1]).not.toContain('--settings')

    const port2 = fakePort({ hooksInfo: vi.fn(async () => ({ port: 1, token: 't' })) })
    const rt2 = createLaunchRuntime(ctx(port2))
    rt2.launchSession('claude --settings /my.json', '/repo', 'C', 'claude')
    await Promise.resolve()
    await Promise.resolve()
    const spawned2 = (port2.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(spawned2.match(/--settings/g)).toHaveLength(1)
  })

  it('starts the codex rollout tail once the probe captures the session id', async () => {
    const timers: Array<() => void> = []
    const port = fakePort({ isTauri: true, detectCliSession: vi.fn(async () => 'cx-id-1') })
    useAppStore.setState({ agentTypes: [agentType({ id: 'codex', model: 'codex', probe: 'codex' })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port, { later: vi.fn((_ms: number, fn: () => void) => { timers.push(fn) }) }))
    const id = rt.launchSession('codex', '/repo', 'CX', 'codex')!
    await Promise.resolve()
    timers[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(port.watchTranscript).toHaveBeenCalledWith(id, 'codex', '', 'cx-id-1', true)
  })

  it('pins the OpenCode server to an allocated port and watches its event bus', async () => {
    const port = fakePort({ freePort: vi.fn(async () => 45678) })
    useAppStore.setState({ agentTypes: [agentType({ id: 'opencode', model: 'opencode', probe: 'opencode' })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('opencode', '/repo', 'OC', 'opencode')!
    await Promise.resolve()
    await Promise.resolve()
    const spawned = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(spawned).toContain('--port 45678 --hostname 127.0.0.1')
    expect(port.watchOpencode).toHaveBeenCalledWith(id, 45678)
    // user-pinned ports are respected
    const port2 = fakePort({ freePort: vi.fn(async () => 45678) })
    createLaunchRuntime(ctx(port2)).launchSession('opencode --port 5000', '/repo', 'OC', 'opencode')
    await Promise.resolve()
    await Promise.resolve()
    expect(port2.freePort).not.toHaveBeenCalled()
    expect(port2.watchOpencode).not.toHaveBeenCalled()
  })

  it('kiro: refreshes the global hook bridge and exports the session id', async () => {
    const port = fakePort({ hooksInfo: vi.fn(async () => ({ port: 4242, token: 'tok' })) })
    useAppStore.setState({ agentTypes: [agentType({ id: 'kiro', model: 'kiro-cli chat' })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('kiro-cli chat', '/repo', 'K', 'kiro')!
    await Promise.resolve()
    await Promise.resolve()
    expect(port.installKiroHooks).toHaveBeenCalledWith('http://127.0.0.1:4242/hook?token=tok')
    const spawned = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(spawned).toContain(`YAAM_SESSION=${id} `)
    expect(spawned).toContain('kiro-cli chat')
  })

  it('acp: starts the stdio peer instead of a PTY and marks the agent', async () => {
    const port = fakePort()
    useAppStore.setState({ agentTypes: [agentType({ id: 'kiro-acp', model: 'kiro-cli acp', acp: true })] } as Partial<AppState> as AppState)
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('kiro-cli acp', '/repo', 'K', 'kiro-acp')!
    await Promise.resolve()
    await Promise.resolve()
    expect(port.acpStart).toHaveBeenCalledWith(id, 'kiro-cli acp', '/repo', 'zsh')
    expect(port.spawnSession).not.toHaveBeenCalled()
    expect(useAppStore.getState().agents.find(a => a.id === id)?.acp).toBe(true)
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

describe('sandboxed launches', () => {
  it('refuses a sandbox without a working folder before creating a session', () => {
    const port = fakePort()
    const c = ctx(port)
    const rt = createLaunchRuntime(c)
    expect(rt.launchSession('mycli run', '', 'Sbx', 'cli', undefined, { sandbox: {} })).toBeNull()
    expect(c.flash).toHaveBeenCalledWith('Sandboxed sessions need a specific working folder')
    expect(port.attachTerminal).not.toHaveBeenCalled()
    expect(useAppStore.getState().agents).toEqual([])
  })

  it('refuses home/root as ineffective sandbox working folders', () => {
    const port = fakePort()
    const c = ctx(port)
    const rt = createLaunchRuntime(c)
    expect(rt.launchSession('mycli run', '~', 'Sbx', 'cli', undefined, { sandbox: {} })).toBeNull()
    expect(rt.launchSession('mycli run', '/', 'Sbx', 'cli', undefined, { sandbox: {} })).toBeNull()
    expect(port.attachTerminal).not.toHaveBeenCalled()
  })

  it('uses a remote machine default as the sandbox working folder', () => {
    const machine = { id: 'm1', label: 'Box', host: 'box.test', user: 'u', remoteDir: '~/project' } as Machine
    useAppStore.setState({ settings: { shell: 'zsh', machines: [machine] } as AppState['settings'] } as Partial<AppState> as AppState)
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    expect(rt.launchSession('mycli run', '', 'Sbx', 'cli', undefined, { machineId: 'm1', sandbox: {} })).not.toBeNull()
    const cmd = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    const b64 = /printf %s (\S+) \| base64 -d/.exec(cmd)?.[1]
    expect(atob(b64!)).toContain('--bind "$HOME"/\'project\' "$HOME"/\'project\'')
  })

  it('wraps a local spawn in the backend sandbox wrapper', async () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Sbx', 'cli', undefined, { sandbox: {} })!
    await Promise.resolve(); await Promise.resolve()
    expect(port.sandboxWrapper).toHaveBeenCalledWith(id, '/repo', [], false)
    expect(port.spawnSession).toHaveBeenCalledWith(
      id, expect.stringMatching(/^sandbox-exec -f '\/fake\.sb' \/bin\/sh -c 'mycli run/), '/repo', undefined, undefined, undefined, 'zsh')
    expect(useAppStore.getState().agents.find(a => a.id === id)?.sandbox).toEqual({})
  })

  it('forwards denyNetwork and extraPaths to the wrapper', async () => {
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Sbx', 'cli', undefined, { sandbox: { denyNetwork: true, extraPaths: ['/data'] } })!
    await Promise.resolve()
    expect(port.sandboxWrapper).toHaveBeenCalledWith(id, '/repo', ['/data'], true)
  })

  it('sandbox + isolate: the wrapper is built from the worktree workdir', async () => {
    const port = fakePort({
      createWorktree: vi.fn(async (base: string, slug: string) => ({
        root: `/wt/${slug}`, base, slug, workdir: `/wt/${slug}/repo`,
        repos: [{ name: 'repo', source: base, branch: `yaam/${slug}`, base_ref: 'main' }],
      })),
    })
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Sbx', 'cli', undefined, { isolate: true, sandbox: {} })!
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(port.sandboxWrapper).toHaveBeenCalledWith(id, `/wt/${id}/repo`, [], false)
  })

  it('fails closed: a wrapper rejection errors the session and nothing spawns', async () => {
    const port = fakePort({ sandboxWrapper: vi.fn(async () => { throw new Error('sandbox: bwrap is not installed') }) })
    const rt = createLaunchRuntime(ctx(port))
    const id = rt.launchSession('mycli run', '/repo', 'Sbx', 'cli', undefined, { sandbox: {} })!
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const agent = useAppStore.getState().agents.find(a => a.id === id)
    expect(agent?.status).toBe('error')
    expect(agent?.log.some(l => l.t === 'err' && l.x.includes('bwrap'))).toBe(true)
    expect(port.spawnSession).not.toHaveBeenCalled()
  })

  it('machine launch: the bwrap sandbox rides inside the ssh wrap for the remote host', () => {
    const machine = { id: 'm1', label: 'Box', host: 'box.test', user: 'u' } as Machine
    useAppStore.setState({ settings: { shell: 'zsh', machines: [machine] } as AppState['settings'] } as Partial<AppState> as AppState)
    const port = fakePort()
    const rt = createLaunchRuntime(ctx(port))
    rt.launchSession('mycli run', '/home/u/proj', 'Sbx', 'cli', undefined, { machineId: 'm1', sandbox: {} })
    // local wrapper never consulted for a machine session
    expect(port.sandboxWrapper).not.toHaveBeenCalled()
    const cmd = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    // the inner command travels base64-encoded; decode and check the bwrap wrap
    const b64 = /printf %s (\S+) \| base64 -d/.exec(cmd)?.[1]
    expect(b64).toBeTruthy()
    const inner = atob(b64!)
    expect(inner).toContain('command -v bwrap')
    expect(inner).toContain('set -- bwrap --ro-bind / /')
    expect(inner).toContain('exec "$@" sh -c')
    expect(inner).toContain('mycli run')
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
    // cmd keeps the ORIGINAL command — resume re-derives the attach wrapper
    // (and relaunches the command if the host ended)
    expect(a?.cmd).toBe('sleep 999')
  })
})

describe('task template launches', () => {
  it('uses a template machine default directory before the local default', () => {
    const machine = { id: 'remote', label: 'Remote', host: 'remote.test', user: 'u', remoteDir: '~/remote-project' } as Machine
    const template = {
      id: 'tpl', name: 'Worker', typeId: 'cli', mode: 'ephemeral', prompt: '{task}', systemPrompt: '',
      model: '', approval: 'edits', cwd: '', extraArgs: '', autoArchive: false, machineId: machine.id, sandbox: {},
    } as AgentTemplate
    useAppStore.setState({
      templates: [template],
      settings: { shell: 'zsh', defaultCwd: '/local-only', machines: [machine] } as AppState['settings'],
    } as Partial<AppState> as AppState)
    const port = fakePort()
    const id = createLaunchRuntime(ctx(port)).launchFromTemplate(template.id)
    expect(id).toBeTruthy()
    expect(useAppStore.getState().agents.find(a => a.id === id)?.cwd).toBe('~/remote-project')
    const cmd = (port.spawnSession as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    const b64 = /printf %s (\S+) \| base64 -d/.exec(cmd)?.[1]
    expect(atob(b64!)).toContain('cd "$HOME"/\'remote-project\'')
    expect(atob(b64!)).not.toContain('/local-only')
  })

  it('uses the task-specific machine instead of the template default', () => {
    const templateMachine = { id: 'template-host', label: 'Template host', host: 'template.test', user: 'tpl' } as Machine
    const taskMachine = { id: 'task-host', label: 'Task host', host: 'task.test', user: 'task' } as Machine
    const template = {
      id: 'tpl', name: 'Worker', typeId: 'cli', mode: 'ephemeral', prompt: '{task}', systemPrompt: '',
      model: '', approval: 'edits', cwd: '/template', extraArgs: '', autoArchive: false,
      machineId: templateMachine.id,
    } as AgentTemplate
    const task = {
      id: 't1', title: 'Run remotely', col: 'backlog', agentId: null,
      templateId: template.id, machineId: taskMachine.id, cwd: '/task',
    } as BoardTask
    useAppStore.setState({
      templates: [template], tasks: [task],
      settings: { shell: 'zsh', machines: [templateMachine, taskMachine] } as AppState['settings'],
    } as Partial<AppState> as AppState)

    const port = fakePort()
    const id = createLaunchRuntime(ctx(port)).spawnTaskSession(task.id)
    expect(id).toBeTruthy()
    const launched = useAppStore.getState().agents.find(a => a.id === id)
    expect(launched?.machine?.id).toBe(taskMachine.id)
    expect(launched?.history?.[0]).toMatchObject({ kind: 'task', taskId: 't1', actor: 'watcher' })
    expect(useAppStore.getState().tasks[0].history?.[0]).toMatchObject({ sessionId: id, kind: 'task' })
    expect(port.spawnSession).toHaveBeenCalledWith(id, expect.stringContaining("'task@task.test'"), undefined, undefined, undefined, undefined, 'zsh')
  })
})
