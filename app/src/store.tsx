/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { ActionsCtx } from './core/context'
import { createAppRuntime } from './app/conductor-runtime'
import type { AppRuntime } from './app/conductor-runtime'
import { useGlobalEffects } from './app/global-effects'
import { windowRole } from './core/window-role'

export { cronMatches, humanizeCron } from './domains/schedules/cron'

/** Composition root — now just lifecycle glue. It builds the non-React
 *  AppRuntime once (state mirroring, timers, every domain subsystem, and the
 *  composed action surface all live there), starts it on mount, disposes it on
 *  unmount, and hands `actions` to the UI. The provider never subscribes to the
 *  store, so terminal output and chat streaming never rerender it; UI components
 *  read reactive state through useConductorSelector. */
export function ConductorProvider({ children }: { children: ReactNode }) {
  // create-once (survives StrictMode's double render); start/dispose bound to mount
  const ref = useRef<AppRuntime>(undefined)
  if (!ref.current) ref.current = createAppRuntime(windowRole())
  const runtime = ref.current
  useEffect(() => {
    runtime.start()
    return () => runtime.dispose()
  }, [runtime])

  useGlobalEffects()

  return <ActionsCtx.Provider value={runtime.actions}>{children}</ActionsCtx.Provider>
}

export { useConductor, useConductorSelector, useActions, shallowEqual } from './store/hooks'
