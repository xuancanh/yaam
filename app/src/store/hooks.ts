// Consumer hooks for the conductor store. State lives in the Zustand store
// (core/store); actions come from the provider via ActionsCtx. Re-exported from
// ../store for existing imports.
import { useContext } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
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
 *  update. Backed by Zustand's selector subscription. */
export function useConductorSelector<T>(selector: (s: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  return useStoreWithEqualityFn(useAppStore, selector, isEqual)
}

/** Read the stable action surface and fail fast outside the provider. */
export function useActions(): ConductorActions {
  const a = useContext(ActionsCtx)
  if (!a) throw new Error('useActions outside provider')
  return a
}
