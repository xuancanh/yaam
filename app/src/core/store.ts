// The app's single Zustand store holding AppState (data only — actions and
// runtime live in the ConductorProvider). Consumers read via useConductor()
// (full) or useConductorSelector(sel) (narrow slice); the provider drives
// updates through `dispatch`, which mirrors the old reducer's semantics.
import { create } from 'zustand'
import { seedState } from './data'
import type { AppState } from './types'

export const useAppStore = create<AppState>(() => seedState())

/** Apply a pure updater, replacing state. No-ops (updater returns the same
 *  reference) skip the update, matching the previous reducer's bail-out. */
export function dispatch(updater: (s: AppState) => AppState): void {
  const cur = useAppStore.getState()
  const next = updater(cur)
  if (next !== cur) useAppStore.setState(next, true)
}
