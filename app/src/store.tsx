/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { ActionsCtx } from './core/context'
import { dispatch, useAppStore } from './core/store'
import { useActivityService } from './domains/activity/service'
import { useConductorRuntime } from './app/conductor-runtime'
import { useConductorActions } from './app/conductor-actions'
import { useGlobalEffects } from './app/global-effects'

export { cronMatches, humanizeCron } from './domains/schedules/cron'

/** Composition root: wires the domain action slices, runtime hooks (settle,
 *  launch, scheduler, persistence/boot, monitor/watcher/master/chat/addon
 *  runners), and effects into the single ActionsCtx surface for the UI. State
 *  lives in the Zustand store; domain logic lives in domains/* and
 *  infrastructure/*. */
export function ConductorProvider({ children }: { children: ReactNode }) {
  // A pure composition root: it renders only <ActionsCtx> and reads state through
  // stateRef in callbacks/effects, so it must NOT subscribe to the whole store
  // (that would re-render it on every terminal line and chat delta). stateRef is
  // mirrored from the store via a direct subscription; UI components read reactive
  // state through useConductorSelector.
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(useAppStore.getState())
  useEffect(() => useAppStore.subscribe(next => { stateRef.current = next }), [])

  useEffect(() => {
    const timers = pending.current
    return () => {
      timers.forEach(t => window.clearTimeout(t))
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  // Schedule a tracked timeout so provider unmount can cancel outstanding work.
  // The id is removed once it fires so the tracking array can't grow without
  // bound over a long-lived session (Master turns, watchers, etc. call this a lot).
  const later = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      const i = pending.current.indexOf(id)
      if (i !== -1) pending.current.splice(i, 1)
      fn()
    }, ms)
    pending.current.push(id)
  }, [])

  // Replace the transient toast and clear it after a short display window.
  const flash = useCallback((t: string) => {
    dispatch(s => ({ ...s, toast: t }))
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => dispatch(s => ({ ...s, toast: null })), 2600)
  }, [])

  // events/notifications land in the OWNING workspace (sessions in background
  // workspaces keep reporting into their own stash)
  const { widOf, logEvent, notify } = useActivityService()

  // Wire every domain runtime (monitor/watcher/chat/master/addon), session
  // helpers, scheduler, persistence/boot, and integrations; then compose the
  // action surface. Runtime + action wiring live in app/conductor-*.
  const kernel = { stateRef, dragId, later, flash, widOf, logEvent, notify }
  const runtime = useConductorRuntime(kernel)
  const actions = useConductorActions({ ...kernel, ...runtime })

  useGlobalEffects()

  return <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
}

export { useConductor, useConductorSelector, useActions, shallowEqual } from './store/hooks'
