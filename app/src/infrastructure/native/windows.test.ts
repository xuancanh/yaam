// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Simulate the desktop app and control the close event + this window's label.
vi.mock('./base', () => ({ isTauri: true }))
let closeCb: ((label: string) => void) | undefined
const currentLabel = vi.fn(() => 'ws-x')
vi.mock('./session', () => ({
  onCloseRequested: vi.fn((cb: (label: string) => void) => { closeCb = cb; return () => { closeCb = undefined } }),
  currentWindowLabel: () => currentLabel(),
}))
const getAllWindows = vi.fn()
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getAll: () => getAllWindows() },
}))

import { onThisWindowClose, requestAllSatellitesClose, runMainWindowClose, type MainWindowCloseDeps } from './windows'

beforeEach(() => {
  vi.clearAllMocks(); closeCb = undefined; currentLabel.mockReturnValue('ws-x')
  getAllWindows.mockReset(); getAllWindows.mockResolvedValue([])
})

describe('onThisWindowClose — window-scoped close', () => {
  it('runs the teardown only for THIS window, ignoring other windows closing', () => {
    const cb = vi.fn()
    onThisWindowClose(cb)
    closeCb!('main')      // a different window closed → ignore
    expect(cb).not.toHaveBeenCalled()
    closeCb!('ws-x')      // this window closed → run
    expect(cb).toHaveBeenCalledOnce()
  })

  it('the main window only reacts to its own close, not a satellite closing', () => {
    currentLabel.mockReturnValue('main')
    const cb = vi.fn()
    onThisWindowClose(cb)
    closeCb!('ws-x')      // a satellite closed → main must not tear down
    expect(cb).not.toHaveBeenCalled()
    closeCb!('main')
    expect(cb).toHaveBeenCalledOnce()
  })
})

describe('requestAllSatellitesClose — graceful satellite close', () => {
  it('asks every satellite to close gracefully (close, NOT destroy) and skips main', async () => {
    const main = { label: 'main', close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }
    const satA = { label: 'ws-a', close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }
    const satB = { label: 'ws-b', close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) }
    getAllWindows.mockResolvedValue([main, satA, satB])
    const labels = await requestAllSatellitesClose()
    expect(labels).toEqual(['ws-a', 'ws-b'])
    expect(satA.close).toHaveBeenCalledOnce()
    expect(satB.close).toHaveBeenCalledOnce()
    // destroy would skip the satellite's close-request → ws:reattach handshake
    expect(satA.destroy).not.toHaveBeenCalled()
    expect(satB.destroy).not.toHaveBeenCalled()
    expect(main.close).not.toHaveBeenCalled()
    expect(main.destroy).not.toHaveBeenCalled()
  })
})

// A controllable clock so the grace/flush timers fire only when the test says.
function fakeClock() {
  const timers: Array<{ fn: () => void; ms: number; disposed: boolean }> = []
  return {
    timers,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, disposed: false }
      timers.push(t)
      return { dispose: () => { t.disposed = true } }
    },
    fireAll: () => { for (const t of timers.splice(0)) if (!t.disposed) t.fn() },
  }
}

function closeDeps(order: string[], clock: ReturnType<typeof fakeClock>, labels: string[]) {
  let reattach: ((label: string) => void) | undefined
  const deps: MainWindowCloseDeps = {
    requestSatelliteClose: () => { order.push('close-satellites'); return Promise.resolve(labels) },
    onReattach: cb => { reattach = cb },
    flush: () => { order.push('flush'); return Promise.resolve() },
    destroySatellites: () => { order.push('destroy-satellites'); return Promise.resolve() },
    destroyMain: () => { order.push('destroy-main'); return Promise.resolve() },
    setTimeout: clock.setTimeout,
  }
  // simulate main's ws:reattach listener: merge the slice into state, THEN
  // notify the close sequence (mirrors conductor-runtime's wiring)
  const deliver = (label: string) => { order.push(`merge:${label}`); reattach!(label) }
  return { deps, deliver }
}

describe('runMainWindowClose — main-quit ordering (REL-1)', () => {
  it('closes satellites before flushing and merges their reattach before flush', async () => {
    const order: string[] = []
    const clock = fakeClock()
    const { deps, deliver } = closeDeps(order, clock, ['ws-a'])
    const done = runMainWindowClose(deps)
    await Promise.resolve(); await Promise.resolve()
    expect(order).toEqual(['close-satellites'])   // waiting on the handoff, not flushing yet
    deliver('ws-a')                                // handoff arrives in the grace window
    await done
    expect(order).toEqual(['close-satellites', 'merge:ws-a', 'flush', 'destroy-satellites', 'destroy-main'])
  })

  it('waits for every closing satellite before flushing', async () => {
    const order: string[] = []
    const clock = fakeClock()
    const { deps, deliver } = closeDeps(order, clock, ['ws-a', 'ws-b'])
    const done = runMainWindowClose(deps)
    await Promise.resolve(); await Promise.resolve()
    deliver('ws-a')
    await Promise.resolve(); await Promise.resolve()
    expect(order).toEqual(['close-satellites', 'merge:ws-a'])   // still waiting on ws-b
    deliver('ws-b')
    await done
    expect(order).toEqual(['close-satellites', 'merge:ws-a', 'merge:ws-b', 'flush', 'destroy-satellites', 'destroy-main'])
  })

  it('proceeds on the grace timeout when a satellite never hands off, then destroys the straggler', async () => {
    const order: string[] = []
    const clock = fakeClock()
    const { deps, deliver } = closeDeps(order, clock, ['ws-a', 'ws-b'])
    const done = runMainWindowClose(deps)
    await Promise.resolve(); await Promise.resolve()
    deliver('ws-a')                                  // ws-b hangs
    await Promise.resolve(); await Promise.resolve()
    expect(order).not.toContain('flush')
    clock.fireAll()                                  // grace (and flush-cap) timers elapse
    await done
    expect(order).toEqual(['close-satellites', 'merge:ws-a', 'flush', 'destroy-satellites', 'destroy-main'])
  })

  it('counts a reattach that landed before the grace wait started', async () => {
    const order: string[] = []
    const clock = fakeClock()
    const { deps, deliver } = closeDeps(order, clock, [])
    const origRequest = deps.requestSatelliteClose
    deps.requestSatelliteClose = async () => {
      await origRequest()
      order.push('close-satellites:returned')
      deliver('ws-a')                                // arrived during the close() round-trip
      return ['ws-a']
    }
    const done = runMainWindowClose(deps)
    await done                                       // resolves without firing any timer
    expect(order).toEqual([
      'close-satellites', 'close-satellites:returned', 'merge:ws-a',
      'flush', 'destroy-satellites', 'destroy-main',
    ])
  })

  it('flushes immediately when no satellites are open', async () => {
    const order: string[] = []
    const clock = fakeClock()
    const { deps } = closeDeps(order, clock, [])
    await runMainWindowClose(deps)
    expect(order).toEqual(['close-satellites', 'flush', 'destroy-satellites', 'destroy-main'])
    expect(clock.timers).toHaveLength(1)             // only the flush cap; no grace wait
  })
})
