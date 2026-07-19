import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

vi.mock('../../core/terminals', () => ({ isAltScreen: () => false, readScreen: () => [] as string[] }))
vi.mock('../../master', () => ({ hasCreds: () => false }))

import { createSessionSettle } from './use-settle'
import type { SettleDeps } from './use-settle'
import { createFakeStatePort, FakeClock } from '../../core/ports.fakes'
import type { AppState, Agent } from '../../core/types'

const ref = <T,>(v: T) => ({ current: v }) as MutableRefObject<T>

function harness(agents: Agent[]) {
  const state = createFakeStatePort({
    agents, activeWorkspace: 'ws', settings: {}, groups: [], activeGroup: null,
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

  it('start() arms the TUI scan and dispose() stops it and cancels timers', () => {
    const h = harness([agent()])
    h.rt.start()
    expect(h.clock.pending).toBeGreaterThan(0) // scan interval armed
    h.rt.bumpSettle('a1')
    h.rt.dispose()
    expect(h.clock.pending).toBe(0) // scan + settle timers all cleared
  })
})
