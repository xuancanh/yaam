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

  it('start() arms the TUI scan and dispose() stops it and cancels timers', () => {
    const h = harness([agent()])
    h.rt.start()
    expect(h.clock.pending).toBeGreaterThan(0) // scan interval armed
    h.rt.bumpSettle('a1')
    h.rt.dispose()
    expect(h.clock.pending).toBe(0) // scan + settle timers all cleared
  })
})
