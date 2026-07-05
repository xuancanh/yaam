// Application runtime ports: the narrow seams the non-React AppRuntime is built
// on. StatePort abstracts the Zustand store (read / update / subscribe) and
// ClockPort abstracts timers, so domain runtimes can be constructed and tested
// without React or real wall-clock timing. Real implementations wrap the store
// and window; tests pass fakes.
import type { AppState } from './types'
import { useAppStore, dispatch } from './store'

export interface StatePort {
  /** current state snapshot */
  get: () => AppState
  /** apply a pure updater (no-op if it returns the same reference) */
  update: (fn: (s: AppState) => AppState) => void
  /** observe committed changes; returns an unsubscribe fn */
  subscribe: (listener: (next: AppState, prev: AppState) => void) => () => void
}

/** A cancellable scheduled callback. */
export interface Disposable {
  dispose: () => void
}

export interface ClockPort {
  /** milliseconds since epoch */
  now: () => number
  /** run `fn` once after `ms`; dispose() cancels it if it hasn't fired */
  setTimeout: (fn: () => void, ms: number) => Disposable
  /** run `fn` every `ms`; dispose() stops it */
  setInterval: (fn: () => void, ms: number) => Disposable
}

/** StatePort backed by the real Zustand store. */
export function createStorePort(): StatePort {
  return {
    get: () => useAppStore.getState(),
    update: dispatch,
    subscribe: listener => useAppStore.subscribe(listener),
  }
}

/** ClockPort backed by the browser's timers. */
export const browserClock: ClockPort = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = window.setTimeout(fn, ms)
    return { dispose: () => window.clearTimeout(id) }
  },
  setInterval: (fn, ms) => {
    const id = window.setInterval(fn, ms)
    return { dispose: () => window.clearInterval(id) }
  },
}
