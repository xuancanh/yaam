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

  it('keeps refreshing the status card as one running session produces more output', () => {
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
    expect(h.state.get().agents[0].summary).toBe('compiling module A')

    // a SECOND burst on the same run must update the card again — the settle
    // loop re-arms an active session, so status no longer freezes after step 1
    push('running tests · 12 passed')
    h.rt.bumpSettle('a1')
    h.clock.advance(10_000)
    expect(h.state.get().agents[0].summary).toBe('running tests · 12 passed')

    // but the user is only pinged once (the fresh arm); the re-armed
    // continuation refreshes silently unless the output needs attention
    expect(h.deps.notify).toHaveBeenCalledTimes(1)
  })

  it('live-updates the status line from output while the session is still streaming', () => {
    const h = harness([agent({ log: [{ t: 'out', x: 'starting up' }] as Agent['log'] })])
    const push = (line: string) => h.state.update(s => ({
      ...s,
      agents: s.agents.map(a => a.id === 'a1' ? { ...a, log: [...a.log, { t: 'out', x: line }] } : a),
    }))

    // no settle timer has fired — this is the mid-stream card refresh
    push('resolving dependencies')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('resolving dependencies')
    expect(h.state.get().agents[0].responding).toBe(true)

    // further chunks within the throttle window don't churn the card…
    push('linking')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('resolving dependencies')

    // …but once the throttle elapses the newest line shows through
    h.clock.advance(1300)
    push('bundling assets')
    h.rt.bumpSettle('a1')
    expect(h.state.get().agents[0].summary).toBe('bundling assets')
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

  it('start() arms the TUI scan and dispose() stops it and cancels timers', () => {
    const h = harness([agent()])
    h.rt.start()
    expect(h.clock.pending).toBeGreaterThan(0) // scan interval armed
    h.rt.bumpSettle('a1')
    h.rt.dispose()
    expect(h.clock.pending).toBe(0) // scan + settle timers all cleared
  })
})
