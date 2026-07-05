// Consumer hooks for the conductor store. Kept in a light module (React +
// context only, no store internals) so selector behavior is unit-testable and
// Fast Refresh stays happy. Re-exported from ../store for existing imports.
import { useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { AppState } from '../types'
import type { ConductorActions } from '../store'
import { ActionsCtx, StateCtx, StoreCtx } from '../context'

/** Read the current AppState and fail fast when rendered outside the provider.
 *  Re-renders on EVERY state change — prefer useConductorSelector for a slice. */
export function useConductor(): AppState {
  const s = useContext(StateCtx)
  if (!s) throw new Error('useConductor outside provider')
  return s
}

/** Subscribe to a narrow slice of state; the component re-renders only when the
 *  selected value changes (by `isEqual`, default Object.is) rather than on every
 *  update. This is the selective-subscription path (finding #3). */
export function useConductorSelector<T>(selector: (s: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useContext(StoreCtx)
  if (!store) throw new Error('useConductorSelector outside provider')
  const selRef = useRef(selector); selRef.current = selector
  const eqRef = useRef(isEqual); eqRef.current = isEqual
  const cache = useRef<{ v: T } | null>(null)
  // cache the selected value so an unrelated state change (new state object,
  // same slice) returns a referentially-stable result and skips re-render
  const getSelection = useCallback(() => {
    const next = selRef.current(store.getSnapshot())
    if (cache.current && eqRef.current(cache.current.v, next)) return cache.current.v
    cache.current = { v: next }
    return next
  }, [store])
  return useSyncExternalStore(store.subscribe, getSelection, getSelection)
}

/** Read the stable action surface and fail fast outside the provider. */
export function useActions(): ConductorActions {
  const a = useContext(ActionsCtx)
  if (!a) throw new Error('useActions outside provider')
  return a
}
