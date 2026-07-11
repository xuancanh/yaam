import { describe, expect, it, vi } from 'vitest'
import { createSchedulerRuntime } from './runtime'
import type { SchedulerDeps } from './runtime'
import { createFakeStatePort, FakeClock } from '../../core/ports.fakes'
import type { AppState, Cron, BoardTask } from '../../core/types'

const baseState = (over: Partial<AppState> = {}): AppState => ({
  bootStatus: 'ready', activeWorkspace: 'ws', workspaceData: {},
  crons: [], tasks: [], templates: [],
  ...over,
} as unknown as AppState)

function harness(state: AppState, over: Partial<SchedulerDeps> = {}) {
  const port = createFakeStatePort(state)
  const clock = new FakeClock()
  const deps: SchedulerDeps = {
    state: port, clock,
    logEvent: vi.fn(), notify: vi.fn(),
    launchSession: vi.fn(() => 'sid'), spawnTaskSession: vi.fn(() => 'sid'), sendAgentChat: vi.fn(() => null),
    fireAddonHook: vi.fn(), wakeAddonAgent: vi.fn(), canLaunch: true,
    ...over,
  }
  return { rt: createSchedulerRuntime(deps), clock, port, deps }
}

// an every-minute cron that is due now
const dueCron = (over: Partial<Cron> = {}): Cron =>
  ({ id: 'c1', name: 'Nightly', on: true, schedule: '* * * * *', cmd: 'echo hi', cwd: '/x', ...over } as unknown as Cron)

describe('createSchedulerRuntime', () => {
  it('does not tick until the interval elapses, then fires a due command schedule', () => {
    const h = harness(baseState({ crons: [dueCron()] }))
    h.rt.start()
    expect(h.deps.launchSession).not.toHaveBeenCalled() // nothing before the first tick
    h.clock.advance(15000)
    expect(h.deps.launchSession).toHaveBeenCalledWith('echo hi', '/x', 'Nightly', undefined, 'ws')
    expect(h.deps.fireAddonHook).toHaveBeenCalledWith('onCronFired', expect.objectContaining({ kind: 'command' }))
  })

  it('holds fire until boot is settled', () => {
    const h = harness(baseState({ bootStatus: 'loading', crons: [dueCron()] }))
    h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.launchSession).not.toHaveBeenCalled()
    // once ready, the next tick fires
    h.port.set({ ...h.port.get(), bootStatus: 'ready' })
    h.clock.advance(15000)
    expect(h.deps.launchSession).toHaveBeenCalledOnce()
  })

  it('disarms a one-time (at) schedule after it fires', () => {
    const at = new FakeClock()
    const atCron = { id: 'c2', name: 'Once', on: true, at: 1000, cmd: 'run' } as unknown as Cron
    const port = createFakeStatePort(baseState({ crons: [atCron] }))
    const deps: SchedulerDeps = {
      state: port, clock: at, logEvent: vi.fn(), notify: vi.fn(),
      launchSession: vi.fn(() => 'sid'), spawnTaskSession: vi.fn(() => null), sendAgentChat: vi.fn(() => null), fireAddonHook: vi.fn(), wakeAddonAgent: vi.fn(), canLaunch: true,
    }
    createSchedulerRuntime(deps).start()
    at.advance(15000)
    expect(deps.launchSession).toHaveBeenCalledOnce()
    expect(port.get().crons[0].on).toBe(false) // 'at' schedule disarmed
    at.advance(15000)
    expect(deps.launchSession).toHaveBeenCalledOnce() // does not refire
  })

  it('starts a due scheduled task via the one canonical launch path', () => {
    const task = { id: 't1', title: 'Nightly build', col: 'backlog', agentId: null, scheduleAt: 500 } as unknown as BoardTask
    const h = harness(baseState({ tasks: [task] }))
    h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.spawnTaskSession).toHaveBeenCalledWith('t1', { workspaceId: 'ws', briefWatcher: true })
  })

  it('clears a due task that could not launch so it does not refire every tick', () => {
    const task = { id: 't1', title: 'x', col: 'backlog', agentId: null, scheduleAt: 500 } as unknown as BoardTask
    const h = harness(baseState({ tasks: [task] }), { canLaunch: false })
    h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.spawnTaskSession).not.toHaveBeenCalled()
    expect(h.port.get().tasks[0].scheduleAt).toBeUndefined()
  })

  it('wakes an enabled addon agent on its every-cron, once per minute', () => {
    const addon = { id: 'ad1', enabled: true, agent: { system: 'watch', every: '* * * * *' } }
    const h = harness(baseState({ addons: [addon] } as unknown as Partial<AppState>))
    h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.wakeAddonAgent).toHaveBeenCalledWith('ad1', expect.stringContaining('scheduled wake'))
    h.clock.advance(15000) // same minute (fake clock stays inside it) — no second wake
    expect(h.deps.wakeAddonAgent).toHaveBeenCalledOnce()
  })

  it('does not wake disabled addons or ones without an every-cron', () => {
    const addons = [
      { id: 'off', enabled: false, agent: { system: 'x', every: '* * * * *' } },
      { id: 'noevery', enabled: true, agent: { system: 'x' } },
    ]
    const h = harness(baseState({ addons } as unknown as Partial<AppState>))
    h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.wakeAddonAgent).not.toHaveBeenCalled()
  })

  it('dispose() stops the interval', () => {
    const h = harness(baseState({ crons: [dueCron()] }))
    h.rt.start()
    h.rt.dispose()
    h.clock.advance(60000)
    expect(h.deps.launchSession).not.toHaveBeenCalled()
    expect(h.clock.pending).toBe(0)
  })

  it('start() is idempotent and cannot double-fire schedules', () => {
    const h = harness(baseState({ crons: [dueCron()] }))
    h.rt.start(); h.rt.start()
    h.clock.advance(15000)
    expect(h.deps.launchSession).toHaveBeenCalledOnce()
    h.rt.dispose()
    expect(h.clock.pending).toBe(0)
  })
})
