// Contexts live in their own module so hot-reloading store.tsx never
// recreates them (which orphans mounted providers and crashes every hook).
import { createContext } from 'react'
import type { AppState } from './types'
import type { ConductorActions } from '../store'

export const StateCtx = createContext<AppState | null>(null)
export const ActionsCtx = createContext<ConductorActions | null>(null)

/** External-store bridge for selector subscriptions: components that read a
 *  narrow slice subscribe here and re-render only when THAT slice changes,
 *  instead of on every state update (which is what `useConductor()` does). */
export interface ConductorStore {
  subscribe: (cb: () => void) => () => void
  getSnapshot: () => AppState
}
export const StoreCtx = createContext<ConductorStore | null>(null)
