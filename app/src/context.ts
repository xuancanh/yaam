// Contexts live in their own module so hot-reloading store.tsx never
// recreates them (which orphans mounted providers and crashes every hook).
import { createContext } from 'react'
import type { AppState } from './types'
import type { ConductorActions } from './store'

export const StateCtx = createContext<AppState | null>(null)
export const ActionsCtx = createContext<ConductorActions | null>(null)
