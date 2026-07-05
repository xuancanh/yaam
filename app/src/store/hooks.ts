// Consumer hooks for the conductor store. State lives in the Zustand store
// (core/store); actions come from the provider via ActionsCtx. Re-exported from
// ../store for existing imports.
import { useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { AppState } from '../core/types'
import type { ConductorActions } from '../store'
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

/** Read the stable action surface and fail fast outside the provider. */
export function useActions(): ConductorActions {
  const a = useContext(ActionsCtx)
  if (!a) throw new Error('useActions outside provider')
  return a
}
