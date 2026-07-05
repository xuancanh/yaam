// Deterministic fakes for the application runtime ports, for unit tests.
// FakeStatePort holds state in a plain closure with synchronous subscriber
// notification; FakeClock advances virtual time explicitly so timer-driven
// runtimes (scheduler, settle, retries) are testable without real delays.
import type { AppState } from './types'
import type { ClockPort, Disposable, StatePort } from './ports'

export function createFakeStatePort(initial: AppState): StatePort & { set: (s: AppState) => void } {
  let state = initial
  const listeners = new Set<(next: AppState, prev: AppState) => void>()
  const notify = (prev: AppState) => { for (const l of [...listeners]) l(state, prev) }
  return {
    get: () => state,
    update: fn => {
      const prev = state
      const next = fn(prev)
      if (next === prev) return
      state = next
      notify(prev)
    },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    // test escape hatch: replace state and notify (mirrors an external mutation)
    set: s => { const prev = state; state = s; notify(prev) },
  }
}

interface FakeTimer { id: number; fn: () => void; due: number; every?: number }

export class FakeClock implements ClockPort {
  private t = 0
  private seq = 0
  private timers = new Map<number, FakeTimer>()

  now = () => this.t

  setTimeout = (fn: () => void, ms: number): Disposable => {
    const id = ++this.seq
    this.timers.set(id, { id, fn, due: this.t + Math.max(0, ms) })
    return { dispose: () => this.timers.delete(id) }
  }

  setInterval = (fn: () => void, ms: number): Disposable => {
    const id = ++this.seq
    this.timers.set(id, { id, fn, due: this.t + Math.max(1, ms), every: Math.max(1, ms) })
    return { dispose: () => this.timers.delete(id) }
  }

  /** Advance virtual time by `ms`, firing every timer whose deadline passes
   *  (intervals re-arm). Order is by deadline then insertion. */
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      const next = [...this.timers.values()].filter(x => x.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0]
      if (!next) break
      this.t = next.due
      if (next.every) next.due += next.every
      else this.timers.delete(next.id)
      next.fn()
    }
    this.t = target
  }

  /** Number of live timers (for leak assertions). */
  get pending(): number { return this.timers.size }
}
