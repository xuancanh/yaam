import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

// per-test control over the terminal registry: which sessions are full-screen
// TUIs and what their rendered screen shows
const tui = vi.hoisted(() => ({ alt: new Set<string>(), screens: new Map<string, string[]>() }))
vi.mock('../../core/terminals', () => ({
  isAltScreen: (id: string) => tui.alt.has(id),
  readScreen: (id: string) => tui.screens.get(id) ?? ([] as string[]),
}))
vi.mock('../../master', () => ({ hasCreds: () => false }))

import { createSessionSettle } from './use-settle'
import type { SettleDeps } from './use-settle'
import { createFakeStatePort, FakeClock } from '../../core/ports.fakes'
import type { AppState, Agent } from '../../core/types'

const ref = <T,>(v: T) => ({ current: v }) as MutableRefObject<T>

function harness(agents: Agent[], extra: Partial<AppState> = {}) {
  const state = createFakeStatePort({
    agents, activeWorkspace: 'ws', settings: {}, groups: [], activeGroup: null,
    ...extra,
  } as unknown as AppState)
  const clock = new FakeClock()
  const deps: SettleDeps = {
    state, clock, notify: vi.fn(), setNeedsInput: vi.fn(), runMonitor: vi.fn(),
    taskForSession: () => undefined,
    masterEventRef: ref(() => {}), monitorEventRef: ref(() => {}), runWatcherRef: ref(() => {}),
  }
  return { rt: createSessionSettle(deps), clock, state, deps }
}

const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'W', kind: 'real', status: 'running', log: [{ t: 'out', x: 'building...' }], ...over } as unknown as Agent)

describe('createSessionSettle', () => {
  it('bumpSettle schedules a quiet-period check that clears a resolved "needs" prompt', () => {
    const h = harness([agent({
      status: 'needs',
      actionNeeded: 'Approve the command',
      suggestions: [{ id: 'sg1', label: 'Approve', send: 'yes' }],
      log: [{ t: 'out', x: 'plain output line' }] as Agent['log'],
    })])
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].status).toBe('needs') // not yet — waiting out the quiet period
    h.clock.advance(3000)
    expect(h.state.get().agents[0].status).toBe('running') // prompt gone → back to running
    expect(h.state.get().agents[0].actionNeeded).toBeUndefined()
    expect(h.state.get().agents[0].suggestions).toBeUndefined()
  })

  it('disposeSettle cancels a pending quiet-period timer (no late fire)', () => {
    const h = harness([agent({ status: 'needs' })])
    h.rt.bumpSettle('a1')
    h.rt.disposeSettle('a1')
    h.clock.advance(10000)
    expect(h.state.get().agents[0].status).toBe('needs') // timer was cancelled
    expect(h.clock.pending).toBe(0)
  })

  it('keeps forwarding settled output for monitor-authored status refreshes', () => {
    const h = harness([agent({ log: [{ t: 'out', x: 'starting up' }] as Agent['log'] })])
    const push = (line: string) => h.state.update(s => ({
      ...s,
      agents: s.agents.map(a => a.id === 'a1' ? { ...a, log: [...a.log, { t: 'out', x: line }] } : a),
    }))

    // one arm (as a launch / user submit would) then a first burst of output
    h.rt.armResponseWatch('a1')
    push('compiling module A')
    h.rt.bumpSettle('a1')
    h.clock.advance(10_000)
    expect(h.deps.runMonitor).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.deps.runMonitor).mock.calls[0][1]).toContain('compiling module A')
    expect(h.state.get().agents[0].summary).toBeUndefined()

    // a SECOND burst on the same run must update the card again — the settle
    // loop re-arms an active session, so status no longer freezes after step 1
    push('running tests · 12 passed')
    h.rt.bumpSettle('a1')
    h.clock.advance(10_000)
    expect(h.deps.runMonitor).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.deps.runMonitor).mock.calls[1][1]).toContain('running tests · 12 passed')
    expect(h.state.get().agents[0].summary).toBeUndefined()

    // but the user is only pinged once (the fresh arm); the re-armed
    // continuation refreshes silently unless the output needs attention
    expect(h.deps.notify).toHaveBeenCalledTimes(1)
  })

  it('keeps the monitor summary stable while raw output is streaming', () => {
    const h = harness([agent({ summary: 'Preparing the build', log: [{ t: 'out', x: 'starting up' }] as Agent['log'] })])
    const push = (line: string) => h.state.update(s => ({
      ...s,
      agents: s.agents.map(a => a.id === 'a1' ? { ...a, log: [...a.log, { t: 'out', x: line }] } : a),
    }))

    // No settle timer has fired: raw output changes only the responding edge.
    push('resolving dependencies')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('Preparing the build')
    expect(h.state.get().agents[0].responding).toBe(true)

    // Further chunks never overwrite the synthesized monitor summary.
    push('linking')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('Preparing the build')

    h.clock.advance(1300)
    push('bundling assets')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('Preparing the build')
  })

  it('reports a task session to its watcher once per changed screen, not per settle', () => {
    const runWatcher = vi.fn()
    const state = createFakeStatePort({
      agents: [agent({ log: [{ t: 'out', x: 'boot' }] as Agent['log'] })],
      activeWorkspace: 'ws', settings: {}, groups: [], activeGroup: null,
    } as unknown as AppState)
    const clock = new FakeClock()
    const deps: SettleDeps = {
      state, clock, notify: vi.fn(), setNeedsInput: vi.fn(), runMonitor: vi.fn(),
      taskForSession: () => ({ task: { id: 't1' } }) as unknown as ReturnType<SettleDeps['taskForSession']>,
      masterEventRef: ref(() => {}), monitorEventRef: ref(() => {}), runWatcherRef: ref(runWatcher),
    }
    const rt = createSessionSettle(deps)
    const push = (line: string) => state.update(s => ({
      ...s,
      agents: s.agents.map(a => a.id === 'a1' ? { ...a, log: [...a.log, { t: 'out', x: line }] } : a),
    }))

    push('step one')
    rt.bumpSettle('a1'); clock.advance(10_000)
    expect(runWatcher).toHaveBeenCalledTimes(1)
    expect(runWatcher.mock.calls[0][1]).toContain('[progress]') // tagged for queue collapse

    // a second settle on the SAME screen must not wake the watcher again
    rt.bumpSettle('a1'); clock.advance(10_000)
    expect(runWatcher).toHaveBeenCalledTimes(1)

    // genuinely new output does
    push('step two')
    rt.bumpSettle('a1'); clock.advance(10_000)
    expect(runWatcher).toHaveBeenCalledTimes(2)
  })

  it('flushes bounded output checkpoints during a long stream and once more at settle', () => {
    const runWatcher = vi.fn()
    const state = createFakeStatePort({
      agents: [agent({ log: [] })], activeWorkspace: 'ws', settings: {}, groups: [], activeGroup: null,
    } as unknown as AppState)
    const clock = new FakeClock()
    const deps: SettleDeps = {
      state, clock, notify: vi.fn(), setNeedsInput: vi.fn(), runMonitor: vi.fn(),
      taskForSession: () => ({ task: { id: 't1' } }) as unknown as ReturnType<SettleDeps['taskForSession']>,
      masterEventRef: ref(() => {}), monitorEventRef: ref(() => {}), runWatcherRef: ref(runWatcher),
    }
    const rt = createSessionSettle(deps)
    const output = (line: string) => {
      state.update(s => ({ ...s, agents: s.agents.map(a => a.id === 'a1' ? { ...a, log: [...a.log, { t: 'out', x: line }] } : a) }))
      rt.bufferOutput('a1', line)
      rt.bumpSettle('a1')
    }

    output('step 1')
    clock.advance(2500); output('step 2')
    clock.advance(2500); output('step 3')
    clock.advance(2500); output('step 4')
    clock.advance(500) // first 8-second checkpoint
    expect(runWatcher).toHaveBeenCalledTimes(1)
    expect(runWatcher.mock.calls[0][1]).toContain('buffered checkpoint')
    expect(runWatcher.mock.calls[0][1]).toContain('step 1')
    expect(runWatcher.mock.calls[0][1]).toContain('step 4')

    output('final result')
    clock.advance(3000)
    expect(runWatcher).toHaveBeenCalledTimes(2)
    expect(runWatcher.mock.calls[1][1]).toContain('finished sending output')
    expect(runWatcher.mock.calls[1][1]).toContain('final result')
  })

  it('backs off output checkpoints exponentially while output keeps streaming', () => {
    const h = harness([agent({ log: [] })])
    const times: number[] = []
    vi.mocked(h.deps.runMonitor).mockImplementation(() => { times.push(h.clock.now()) })

    // one line per second for 300s: the settle timer never fires, so
    // checkpoints must back off 8s → 16s → 32s → 64s → 120s (cap)
    for (let i = 1; i <= 300; i++) {
      h.rt.bufferOutput('a1', `line ${i}`)
      h.rt.bumpSettle('a1')
      h.clock.advance(1000)
    }
    expect(times).toEqual([8000, 24_000, 56_000, 120_000, 240_000])
  })

  it('skips the monitor turn when a checkpoint only changed in the tail lines', () => {
    const h = harness([agent({ log: [] })])
    const times: number[] = []
    vi.mocked(h.deps.runMonitor).mockImplementation(() => { times.push(h.clock.now()) })
    // push the burst's lines spread over `ms`, bumping every second so the
    // settle timer never fires mid-burst
    const burst = (lines: string[], ms: number) => {
      const step = ms / lines.length
      for (const line of lines) {
        h.rt.bufferOutput('a1', line)
        for (let t = 0; t < step; t += 1000) {
          h.rt.bumpSettle('a1')
          h.clock.advance(1000)
        }
      }
    }
    const head = ['build: compiling x', 'build: compiling y', 'step 1', 'step 2', 'step 3']
    burst([...head, 'tail a', 'tail b', 'tail c'], 8000)  // first checkpoint at 8s fires
    burst([...head, 'tail d', 'tail e', 'tail f'], 16_000) // 24s: identical modulo tail → skip
    burst(['build: compiling z', ...head.slice(1), 'tail g', 'tail h', 'tail i'], 32_000) // 56s: new head → fires
    expect(times).toEqual([8000, 56_000])
  })

  it('resets the checkpoint backoff after a quiet settle', () => {
    const h = harness([agent({ log: [] })])
    const times: number[] = []
    vi.mocked(h.deps.runMonitor).mockImplementation(() => { times.push(h.clock.now()) })
    const stream = (seconds: number, tag: string) => {
      for (let i = 0; i < seconds; i++) {
        h.rt.bufferOutput('a1', `${tag} line ${i}`)
        h.rt.bumpSettle('a1')
        h.clock.advance(1000)
      }
    }
    stream(25, 'a')       // checkpoints at 8s and 24s; next backed off to 32s
    h.clock.advance(3000) // quiet → settle fires at 27s with a final snapshot
    stream(9, 'b')        // backoff reset → next checkpoint 8s into the new burst
    expect(times).toEqual([8000, 24_000, 27_000, 36_000])
  })

  it('start() arms the TUI scan and dispose() stops it and cancels timers', () => {
    const h = harness([agent()])
    h.rt.start()
    expect(h.clock.pending).toBeGreaterThan(0) // scan interval armed
    h.rt.bumpSettle('a1')
    h.rt.dispose()
    expect(h.clock.pending).toBe(0) // scan + settle timers all cleared
  })
})

describe('createSessionSettle detached workspaces', () => {
  const PROMPT_SCREEN = ['Do you want to proceed?', '❯ 1. Yes', '  2. No']

  it('the TUI scan skips agents of a detached workspace (no flag, no monitor note)', () => {
    tui.alt.add('a1'); tui.alt.add('a2')
    tui.screens.set('a1', PROMPT_SCREEN); tui.screens.set('a2', PROMPT_SCREEN)
    const monitorEvent = vi.fn()
    const h = harness([
      agent({ id: 'a1', workspaceId: 'ws-b' }), // spun out into a satellite
      agent({ id: 'a2', workspaceId: 'ws' }),   // still owned by this window
    ], { detachedWorkspaces: ['ws-b'] })
    h.deps.monitorEventRef.current = monitorEvent
    h.rt.start()
    h.clock.advance(4000)
    h.rt.dispose()

    expect(h.deps.setNeedsInput).not.toHaveBeenCalledWith('a1', expect.anything(), expect.anything(), expect.anything())
    expect(monitorEvent).not.toHaveBeenCalledWith('a1', expect.anything())
    expect(h.state.get().agents.find(a => a.id === 'a1')?.status).toBe('running') // untouched
    // the non-detached agent is scanned exactly as before
    expect(h.deps.setNeedsInput).toHaveBeenCalledWith('a2', expect.any(String), expect.anything(), expect.anything())
    expect(monitorEvent).toHaveBeenCalledWith('a2', expect.any(String))
  })

  it('settle arms no timers and feeds no monitor for a detached workspace\'s session', () => {
    const h = harness(
      [agent({ id: 'a1', workspaceId: 'ws-b', log: [{ t: 'out', x: 'working' }] as Agent['log'] })],
      { detachedWorkspaces: ['ws-b'] },
    )
    h.rt.armResponseWatch('a1')
    h.rt.bufferOutput('a1', 'step one')
    h.rt.bumpSettle('a1')
    // only the arm's no-output fallback remains — bumpSettle armed no
    // quiet-period or output-checkpoint timers for the detached session
    expect(h.clock.pending).toBe(1)
    h.clock.advance(30_000)
    expect(h.deps.runMonitor).not.toHaveBeenCalled()
    expect(h.deps.notify).not.toHaveBeenCalled()
    expect(h.state.get().agents[0].status).toBe('running') // no status writes
    expect(h.state.get().agents[0].responding).toBeUndefined()
  })
})
