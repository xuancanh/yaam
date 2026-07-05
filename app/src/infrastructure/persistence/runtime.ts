// The persistence save-side runtime: one owner for the debounced main-partition
// and per-session writers, keychain mirroring, the teardown flush, and save-error
// state. It subscribes to the store directly (not via React), arming a writer
// only when the slices it owns change (pure detectors in ./subscribe). Writes are
// gated on markReady() so nothing overwrites the on-disk state before hydration
// has applied the restored snapshot. Native IPC is fine here (this IS the storage
// layer); it must not touch terminals/xterm — that stays a session concern.
import type { AppState, Agent } from '../../core/types'
import * as native from '../../core/native'
import { selectMainState, selectSession } from './schema'
import { redactSecrets, secretEntries } from '../../store/secrets'
import { mainPartitionChanged, secretsChanged, sessionsChanged } from './subscribe'

export interface PersistenceStorePort {
  getState: () => AppState
  subscribe: (listener: (state: AppState, prev: AppState) => void) => () => void
}

export interface PersistenceRuntime {
  /** Accounts confirmed stored in the OS keychain (so they are redacted from the
   *  plaintext file). Shared with hydration, which seeds it from resolved secrets. */
  readonly keychainReady: Set<string>
  /** Enable writes. Called once the restored snapshot has been applied so the
   *  debounced writers can never clobber saved state during load. */
  markReady: () => void
  /** Wire store subscriptions + the close/unload flush. */
  start: () => void
  /** Persist both partitions from the latest state (teardown); resolves once
   *  every write has settled so a caller can await it before closing. */
  flush: () => Promise<void>
  /** Clear timers, remove listeners, and unsubscribe. */
  dispose: () => void
}

export function createPersistenceRuntime(
  store: PersistenceStorePort,
  opts: { onToast: (msg: string) => void },
): PersistenceRuntime {
  const keychainReady = new Set<string>()
  const savedAgents = new Map<string, Agent>()
  let ready = false
  let saveFailed = false
  let mainTimer: number | undefined
  let sessionTimer: number | undefined
  let secretTimer: number | undefined
  const unsubs: Array<() => void> = []

  // warn once per failure streak, not on every debounced save
  const onSaveError = (where: string, e: unknown) => {
    console.error(`[yaam] ${where} save failed:`, e)
    if (!saveFailed) {
      saveFailed = true
      opts.onToast('Could not save state to disk — recent changes may be lost on restart')
    }
  }

  // Main (low-churn) partition: everything durable except the agents. Reads the
  // latest state at fire time and redacts keychain-safe secrets to plaintext.
  const armMain = () => {
    if (!ready) return
    if (mainTimer) window.clearTimeout(mainTimer)
    mainTimer = window.setTimeout(() => {
      const main = redactSecrets(selectMainState(store.getState()), keychainReady)
      native.saveStateFile(JSON.stringify(main)).then(() => { saveFailed = false }).catch(e => onSaveError('main', e))
    }, 800)
  }

  // Sessions: one file per session. Diff against the last-saved set and write
  // ONLY the agents whose object identity changed (immutable updates ⇒ a changed
  // reference means changed content), and delete files for removed agents.
  const writeSessions = () => {
    const next = new Map<string, Agent>()
    for (const a of store.getState().agents) {
      next.set(a.id, a)
      if (savedAgents.get(a.id) !== a) {
        native.saveSession(a.id, JSON.stringify(selectSession(a))).then(() => { saveFailed = false }).catch(e => onSaveError('session', e))
      }
    }
    for (const id of savedAgents.keys()) {
      if (!next.has(id)) native.removeSession(id).catch(() => {})
    }
    savedAgents.clear()
    for (const [id, a] of next) savedAgents.set(id, a)
  }
  const armSession = () => {
    if (!ready) return
    if (sessionTimer) window.clearTimeout(sessionTimer)
    sessionTimer = window.setTimeout(writeSessions, 800)
  }
  // A session was added or removed (vs the last save) — a structural change, as
  // opposed to a content update on an existing session. New/deleted sessions are
  // persisted immediately so a just-created chat survives a quick restart instead
  // of waiting out the content debounce (and racing the unload flush).
  const sessionSetChanged = (agents: readonly Agent[]) => {
    if (agents.length !== savedAgents.size) return true
    for (const a of agents) if (!savedAgents.has(a.id)) return true
    return false
  }

  // Mirror credential fields into the OS keychain (debounced). Once a secret is
  // confirmed stored, mark it keychain-ready so the main writer redacts it from
  // the plaintext file; a keychain failure leaves it plaintext (no data loss).
  const armSecret = () => {
    if (!ready) return
    if (secretTimer) window.clearTimeout(secretTimer)
    secretTimer = window.setTimeout(() => {
      void (async () => {
        let changed = false
        for (const { account, value } of secretEntries(store.getState())) {
          try {
            if (value) {
              await native.secretSet(account, value)
              if (!keychainReady.has(account)) { keychainReady.add(account); changed = true }
            } else if (keychainReady.delete(account)) {
              await native.secretDelete(account)
            }
          } catch (e) {
            console.error(`[yaam] keychain write failed for ${account}:`, e) // stays plaintext
          }
        }
        // re-persist redacted now that new secrets are safely in the keychain
        if (changed) native.saveStateFile(JSON.stringify(redactSecrets(selectMainState(store.getState()), keychainReady))).catch(() => {})
      })()
    }, 900)
  }

  // Persist both partitions from the latest state, through the same selectors as
  // the debounced writers so they can never drift apart. Resolves once every
  // write settles, so teardown can await durability before closing the window.
  const flush = async (): Promise<void> => {
    const st = store.getState()
    const writes: Array<Promise<unknown>> = [
      native.saveStateFile(JSON.stringify(redactSecrets(selectMainState(st), keychainReady))).catch(e => onSaveError('main', e)),
    ]
    for (const a of st.agents) {
      if (savedAgents.get(a.id) !== a) writes.push(native.saveSession(a.id, JSON.stringify(selectSession(a))).catch(e => onSaveError('session', e)))
    }
    await Promise.allSettled(writes)
  }
  // Fallback flush for a plain-browser dev context, where there is no Tauri
  // close lifecycle to coordinate with (best-effort, can't be awaited).
  const onBeforeUnload = () => { void flush() }
  let closeOff: (() => void) | undefined

  return {
    keychainReady,
    markReady() { ready = true },
    start() {
      unsubs.push(store.subscribe((s, prev) => { if (mainPartitionChanged(s, prev)) armMain() }))
      unsubs.push(store.subscribe((s, prev) => {
        if (!sessionsChanged(s, prev)) return
        if (ready && sessionSetChanged(s.agents)) {
          if (sessionTimer) window.clearTimeout(sessionTimer)
          writeSessions()
        } else armSession()
      }))
      unsubs.push(store.subscribe((s, prev) => { if (secretsChanged(s, prev)) armSecret() }))
      // In Tauri the OS close is vetoed backend-side; flush (bounded so a stuck
      // write can't wedge the close), then destroy the window. In a plain
      // browser fall back to the best-effort beforeunload flush.
      if (native.isTauri) {
        closeOff = native.onCloseRequested(() => {
          void (async () => {
            await Promise.race([flush(), new Promise(r => window.setTimeout(r, 3000))])
            await native.destroyWindow().catch(() => {})
          })()
        })
      } else {
        window.addEventListener('beforeunload', onBeforeUnload)
      }
    },
    flush,
    dispose() {
      if (mainTimer) window.clearTimeout(mainTimer)
      if (sessionTimer) window.clearTimeout(sessionTimer)
      if (secretTimer) window.clearTimeout(secretTimer)
      for (const u of unsubs) u()
      closeOff?.()
      window.removeEventListener('beforeunload', onBeforeUnload)
    },
  }
}
