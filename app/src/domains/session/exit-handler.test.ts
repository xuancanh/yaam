import { describe, expect, it, vi } from 'vitest'
import { coordinateSessionExit } from './exit-handler'
import type { SessionExitPorts } from './exit-handler'
import type { AppState, Agent, BoardTask } from '../../core/types'
import type { LocatedTask } from '../board/task-state'

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Worker', repo: 'acme/app', status: 'running', attention: false,
  kind: 'agent', log: [{ t: 'sys', x: 'started' }], cmd: undefined, cwd: '', launchedAt: 0,
  ...extra,
} as unknown as Agent)

const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask =>
  ({ id, title: id, col: 'doing', agentId: 'a1', ...extra } as BoardTask)

// A harness: seeds state, wires spy ports over a mutable state closure, runs the
// fan-out, and exposes the resulting state + spies for assertions.
function harness(seed: Partial<AppState>, opts: { locatedTask?: LocatedTask; userStopped?: boolean } = {}) {
  let state = {
    activeWorkspace: 'ws', agentTypes: [], tasks: [], minimizedIds: [], groups: [], workspaceData: {},
    ...seed,
  } as unknown as AppState
  const stateRef = { current: state }
  const scheduled: Array<() => void> = []
  const ports: SessionExitPorts = {
    stateRef,
    dispatch: fn => { state = fn(state); stateRef.current = state },
    takeUserStopped: vi.fn(() => !!opts.userStopped),
    taskForSession: vi.fn(() => opts.locatedTask),
    pushTaskChat: vi.fn(),
    logEvent: vi.fn(),
    notify: vi.fn(),
    fireAddonHook: vi.fn(),
    runWatcher: vi.fn(),
    monitorEvent: vi.fn(),
    detectCliSession: vi.fn(async () => null),
    scheduleArchive: vi.fn((fn: () => void) => { scheduled.push(fn) }),
    quiesceTerminal: vi.fn(),
  }
  return {
    ports, scheduled,
    run: (code: number | null) => coordinateSessionExit({ id: 'a1', code }, ports),
    state: () => state,
  }
}

describe('coordinateSessionExit', () => {
  it('every exit restores the terminal modes the dead process left behind', () => {
    // Ctrl+C exit — the TUI never restored the alt screen/mouse modes itself
    const h = harness({ agents: [agent()] })
    h.run(130)
    expect(h.ports.quiesceTerminal).toHaveBeenCalledWith('a1')
  })

  it('a user stop stays idle+quiet: no notify, no monitor, logs the stop', () => {
    const h = harness({ agents: [agent({ ephemeral: true })] }, { userStopped: true })
    const cls = h.run(137)
    expect(cls.outcome).toBe('stopped')
    const a = h.state().agents[0]
    expect(a.status).toBe('idle')       // a stop is never an error
    expect(a.attention).toBe(false)     // no attention flag on a user stop
    expect(h.ports.notify).not.toHaveBeenCalled()
    expect(h.ports.monitorEvent).not.toHaveBeenCalled()
    expect(h.ports.logEvent).toHaveBeenCalledWith('edit', 'a1', expect.stringContaining('stopped by you'))
  })

  it('a clean one-shot exit completes: idle, notifies done, reports to the monitor', () => {
    const h = harness({ agents: [agent({ ephemeral: true })] })
    const cls = h.run(0)
    expect(cls.outcome).toBe('completed')
    expect(h.state().agents[0].status).toBe('idle')
    expect(h.state().agents[0].history?.[0]).toMatchObject({ actor: 'session', kind: 'complete' })
    expect(h.ports.notify).toHaveBeenCalledWith('done', expect.stringContaining('completed'), expect.any(String), 'a1')
    expect(h.ports.monitorEvent).toHaveBeenCalledOnce()
    expect(h.ports.fireAddonHook).toHaveBeenCalledWith('onSessionExit', expect.objectContaining({ sessionId: 'a1', code: 0 }))
  })

  it('a failed one-shot exit errors and never auto-archives', () => {
    const h = harness({ agents: [agent({ ephemeral: true, autoArchive: true })] })
    const cls = h.run(1)
    expect(cls).toMatchObject({ outcome: 'failed', failed: true, autoArchive: false })
    expect(h.state().agents[0].status).toBe('error')
    expect(h.ports.notify).toHaveBeenCalledWith('escalate', expect.any(String), expect.any(String), 'a1')
    expect(h.ports.scheduleArchive).not.toHaveBeenCalled()
  })

  it('a clean one-shot with auto-archive schedules the tidy-up, which archives on fire', () => {
    const h = harness({ agents: [agent({ ephemeral: true, autoArchive: true })], minimizedIds: ['a1'] })
    h.run(0)
    expect(h.ports.scheduleArchive).toHaveBeenCalledOnce()
    expect(h.state().agents[0].archived).toBeFalsy() // not archived until the timer fires
    h.scheduled[0]()                                   // simulate the delay elapsing
    const a = h.state().agents[0]
    expect(a.archived).toBe(true)
    expect(a.attention).toBe(false)
    expect(h.state().minimizedIds).not.toContain('a1')
  })

  it('a clean interactive (non-ephemeral) exit finishes and reports to the monitor', () => {
    const h = harness({ agents: [agent({ ephemeral: false })] })
    const cls = h.run(0)
    expect(cls.outcome).toBe('exited')
    expect(h.state().agents[0].status).toBe('idle')
    expect(h.ports.notify).toHaveBeenCalledWith('done', expect.stringContaining('finished'), expect.any(String), 'a1')
    expect(h.ports.monitorEvent).toHaveBeenCalledOnce()
    expect(h.ports.scheduleArchive).not.toHaveBeenCalled()
  })

  it('a task session routes through the watcher, moves the task to review, and skips the monitor', () => {
    const located: LocatedTask = { task: task('t1'), workspaceId: 'ws' }
    const h = harness({
      agents: [agent({ ephemeral: true })], tasks: [task('t1')],
      settings: { masterEnabled: true, apiKey: 'k', provider: 'anthropic', credCmd: '' },
    } as Partial<AppState>, { locatedTask: located })
    h.run(0)
    expect(h.ports.monitorEvent).not.toHaveBeenCalled() // task work reports via its watcher
    expect(h.ports.runWatcher).toHaveBeenCalledWith('t1', expect.any(String))
    expect(h.ports.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('cleanly'))
    expect(h.state().tasks.find(t => t.id === 't1')?.col).toBe('review')
    expect(h.state().tasks.find(t => t.id === 't1')?.history?.[0]).toMatchObject({
      kind: 'complete', sessionId: 'a1', taskId: 't1',
    })
  })

  it('with the brain off, a task session reaches a final state deterministically and guides the user', () => {
    const located: LocatedTask = { task: task('t1'), workspaceId: 'ws' }
    // no settings → no Master Brain
    const h = harness({ agents: [agent({ ephemeral: true })], tasks: [task('t1')] }, { locatedTask: located })
    h.run(0)
    expect(h.ports.runWatcher).not.toHaveBeenCalled() // no brain: no watcher to assess
    expect(h.state().tasks.find(t => t.id === 't1')?.col).toBe('review')
    expect(h.state().tasks.find(t => t.id === 't1')?.watcherNote).toContain('review')
    expect(h.ports.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('Review'))
  })

  it('with the brain off, a clean exit clears a stale deterministic error flag', () => {
    // a plain (non-task) session that earlier flagged a possible error, now
    // exiting cleanly with error-free output — the flag must not linger
    const h = harness({
      agents: [agent({ ephemeral: false, actionNeeded: 'Possible error — boom', log: [{ t: 'out', x: 'All tests passed' }] })],
    })
    h.run(0)
    expect(h.state().agents[0].actionNeeded).toBeUndefined()
  })

  it('a failed task session moves the task to failed', () => {
    const located: LocatedTask = { task: task('t1'), workspaceId: 'ws' }
    const h = harness({ agents: [agent({ ephemeral: true })], tasks: [task('t1')] }, { locatedTask: located })
    h.run(2)
    expect(h.state().tasks.find(t => t.id === 't1')?.col).toBe('failed')
  })

  it('probes a resume id for a CLI session that has none, then stores it', async () => {
    const detect = vi.fn(async () => 'resume-xyz')
    const h = harness({
      agents: [agent({ cmd: 'claude --print', launchedAt: 1000, cliSessionId: undefined })],
      agentTypes: [{ id: 'claude', model: 'claude', probe: 'claude --resume-probe' }] as unknown as AppState['agentTypes'],
    })
    h.ports.detectCliSession = detect
    h.run(0)
    expect(detect).toHaveBeenCalledWith('claude --resume-probe', undefined, 1000)
    await Promise.resolve() // let the detect promise settle
    expect(h.state().agents[0].cliSessionId).toBe('resume-xyz')
  })
})
