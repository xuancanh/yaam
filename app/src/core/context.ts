// The actions context lives in its own module so hot-reloading store.tsx never
// recreates it (which would orphan mounted providers and crash every hook).
// State is read directly from the Zustand store (core/store), not via context.
import { createContext } from 'react'
import type { ConductorActions } from '../app/actions'

export const ActionsCtx = createContext<ConductorActions | null>(null)
