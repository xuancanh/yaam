// Keep Awake mode: derive whether the Mac should be held out of idle sleep
// from settings + live session state, and mirror changes to the backend
// assertion. Pure derivation here; global-effects owns the subscription.
import type { AppState } from '../core/types'
import { keepAwakeSet } from '../infrastructure/native/power'

/** True when the current state calls for holding the idle-sleep assertion. */
export function keepAwakeDesired(s: Pick<AppState, 'agents' | 'settings'>): boolean {
  const mode = s.settings.keepAwake ?? 'off'
  if (mode === 'off') return false
  if (mode === 'always') return true
  // 'sessions': any live session still working (or waiting on the user —
  // sleeping through a needs-input prompt just stalls the answer longer)
  return s.agents.some(a => !a.archived && (a.status === 'running' || a.status === 'needs'))
}

/** Watch the store and flip the backend assertion on transitions. Returns the
 *  unsubscribe; releases the assertion when torn down. */
export function driveKeepAwake(
  getState: () => AppState,
  subscribe: (fn: (s: AppState) => void) => () => void,
): () => void {
  let current: boolean | null = null
  const apply = (s: AppState) => {
    const want = keepAwakeDesired(s)
    if (want === current) return
    current = want
    keepAwakeSet(want).catch(() => {})
  }
  apply(getState())
  const unsub = subscribe(apply)
  return () => {
    unsub()
    if (current) keepAwakeSet(false).catch(() => {})
  }
}
