// Boot/hydration effect: load the persisted snapshot, apply the pure hydration
// result, rebuild each restored session's terminal (reattaching to PTYs still
// alive in the backend after a webview reload), resolve keychain secrets, then
// mark persistence ready and connect integrations. Runs once. The pure snapshot
// transform lives in ./hydrate; this owns the boot sequencing + terminal reattach.
import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, PersistedState } from '../../core/types'
import { dispatch } from '../../core/store'
import * as native from '../../core/native'
import { getTerminal, repaintSession } from '../../core/terminals'
import { applyResolvedSecrets, secretEntries } from '../../store/secrets'
import { buildHydration } from './hydrate'
import { loadSnapshot } from './loaders'
import type { PersistenceRuntime } from './runtime'

export interface HydrationCtx {
  stateRef: MutableRefObject<AppState>
  persistence: PersistenceRuntime
  startIntegrations: () => void
  appendTail: (id: string, line: string) => void
  clearNeeds: (id: string) => void
  bumpSettle: (id: string) => void
  armResponseWatch: (id: string) => void
}

export function useHydration(ctx: HydrationCtx): void {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    runHydration(ctx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** The one-shot boot sequence: load + apply the persisted snapshot, rebuild
 *  terminals, resolve secrets, mark ready, then start integrations. Plain (no
 *  React); the caller guards against running it twice. */
export function runHydration(ctx: HydrationCtx): void {
  {
    const { stateRef, persistence, startIntegrations, appendTail, clearNeeds, bumpSettle, armResponseWatch } = ctx
    // Apply one merged snapshot: dispatch the pure hydration result, then rebuild terminals.
    const hydrateFrom = (p: Partial<PersistedState>) => {
      const { next, restoredAgents } = buildHydration(p, stateRef.current)
      // pure snapshot applied — now rebuilding terminals + resolving secrets
      dispatch(() => ({ ...next, bootStatus: 'restoring-runtime' }))
      // rebuild each restored session's terminal with its saved tail, and
      // reattach to PTYs that are still alive in the backend (webview reload)
      native.liveSessions().then(liveIds => {
        const alive = new Set(liveIds)
        for (const a of restoredAgents) {
          const { term } = getTerminal(a.id, line => appendTail(a.id, line), () => clearNeeds(a.id), () => bumpSettle(a.id), () => armResponseWatch(a.id))
          if (alive.has(a.id)) {
            // live PTY: never inject text (it corrupts TUI screens) —
            // nudge the app to repaint itself once the pane has mounted
            window.setTimeout(() => repaintSession(a.id), 1200)
          } else {
            for (const l of a.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
            term.writeln('\x1b[33m── restored from previous run · press ▶ to relaunch ──\x1b[0m')
          }
        }
        if (alive.size) {
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => alive.has(a.id)
              ? { ...a, status: 'running' as const, log: a.log.concat([{ t: 'sys' as const, x: 'reattached · session still running' }]) }
              : a),
          }))
        }
      }).catch(() => {})
    }
    void (async () => {
      try {
        const { merged, usedBackup } = await loadSnapshot()
        if (usedBackup) dispatch(s => ({ ...s, toast: 'Restored from backup — the main state file was unreadable' }))
        // start-fresh unless there is something worth restoring
        if (Object.keys(merged).some(k => k !== 'agents') || merged.agents?.length) hydrateFrom(merged)
      } catch (e) {
        console.error('[yaam] hydration failed — starting fresh:', e)
        dispatch(s => ({ ...s, toast: 'Saved state was unreadable — starting fresh', bootStatus: 'failed' }))
      }
      // fill credential fields the file no longer holds from the OS keychain,
      // and mark anything already present (legacy plaintext) as keychain-bound
      try {
        const resolved: Record<string, string> = {}
        for (const { account, value } of secretEntries(stateRef.current)) {
          if (value) continue // legacy plaintext still in the loaded file
          const v = await native.secretGet(account)
          if (v) { resolved[account] = v; persistence.keychainReady.add(account) }
        }
        if (Object.keys(resolved).length) dispatch(s => applyResolvedSecrets(s, resolved))
      } catch (e) {
        console.error('[yaam] keychain resolve failed:', e)
      }
      // restored state is fully applied — enable saves, mark the runtime ready
      // (unless restoration hard-failed above), then connect integrations. Gating
      // dependent runtimes on 'ready'/'failed' keeps them from observing seed
      // state mid-load. Persistence is enabled regardless so post-boot edits save.
      persistence.markReady()
      dispatch(s => (s.bootStatus === 'failed' ? s : { ...s, bootStatus: 'ready' }))
      startIntegrations()
    })()
  }
}
