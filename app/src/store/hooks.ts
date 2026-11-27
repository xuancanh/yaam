// Consumer hooks for the conductor store. State lives in the Zustand store
// (core/store); actions come from the provider via ActionsCtx. Re-exported from
// ../store for existing imports.
import { useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { Agent, AppState } from '../core/types'
import type { ConductorActions } from '../app/actions'
import { useAppStore } from '../core/store'
import { ActionsCtx } from '../core/context'

/** Read the whole AppState. Re-renders on EVERY state change — prefer
 *  useConductorSelector for a narrow slice. */
export function useConductor(): AppState {
  return useAppStore()
}

/** Subscribe to a narrow slice of state; the component re-renders only when the
 *  selected value changes (by `isEqual`, default Object.is) rather than on every
 *  update. Built on the Zustand store's subscribe/getState via React's
 *  useSyncExternalStore (no extra peer deps), with an equality cache so an
 *  unrelated change returns a referentially-stable slice. */
export function useConductorSelector<T>(selector: (s: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const selRef = useRef(selector); selRef.current = selector
  const eqRef = useRef(isEqual); eqRef.current = isEqual
  const cache = useRef<{ v: T } | null>(null)
  const getSelection = useCallback(() => {
    const next = selRef.current(useAppStore.getState())
    if (cache.current && eqRef.current(cache.current.v, next)) return cache.current.v
    cache.current = { v: next }
    return next
  }, [])
  return useSyncExternalStore(useAppStore.subscribe, getSelection, getSelection)
}

/** Shallow (one-level) equality for object/array slices — pass as the second
 *  arg to useConductorSelector when a selector returns a fresh object of several
 *  fields, so it re-renders only when one of those fields actually changes. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

// Agent fields that churn with terminal output and chat streaming: `log`,
// `used`, `cost` every 100ms while a session prints, `chatLog` every frame of a
// chat stream, `chatComposer` on every chat keystroke.
const OUTPUT_FIELDS = new Set(['log', 'used', 'cost', 'usageVersion', 'chatLog', 'chatComposer', 'chatTurns'])

/** Equality for an `agents` array that ignores output churn: equal when every
 *  agent is unchanged apart from its output fields. For surfaces that show
 *  names, status, counts or layout, never the output itself; they otherwise
 *  re-rendered ten times a second while anything printed. */
export function sameAgentsIgnoringOutput(a: readonly Agent[], b: readonly Agent[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>
    const y = b[i] as unknown as Record<string, unknown>
    if (x === y) continue
    for (const k in y) if (!OUTPUT_FIELDS.has(k) && !Object.is(x[k], y[k])) return false
    for (const k in x) if (!(k in y)) return false
  }
  return true
}

/** shallowEqual, except an `agents` field compares with sameAgentsIgnoringOutput. */
export function shallowEqualIgnoringOutput<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) {
    if (k === 'agents') {
      if (!sameAgentsIgnoringOutput(ra[k] as Agent[], rb[k] as Agent[])) return false
    } else if (!Object.is(ra[k], rb[k])) return false
  }
  return true
}

/** Read the stable action surface and fail fast outside the provider. */
export function useActions(): ConductorActions {
  const a = useContext(ActionsCtx)
  if (!a) throw new Error('useActions outside provider')
  return a
}
