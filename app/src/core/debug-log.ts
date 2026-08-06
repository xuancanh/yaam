// In-app debug log: a bounded ring buffer of diagnostic events (HTTP failures,
// registry errors, console errors) that the Developer section in Settings
// renders live. Always captured — it's cheap — so the buffer already holds
// history from before the user flips Developer mode on to look.

export interface DebugEntry {
  at: number
  /** short source tag: 'http', 'console', 'registry', … */
  scope: string
  message: string
}

const MAX_ENTRIES = 500
let entries: DebugEntry[] = []
const subscribers = new Set<() => void>()

/** Record one diagnostic event (newest last). */
export function debugLog(scope: string, message: string): void {
  entries = [...entries, { at: Date.now(), scope, message: message.slice(0, 600) }].slice(-MAX_ENTRIES)
  for (const fn of subscribers) fn()
}

/** Snapshot for useSyncExternalStore — stable reference between writes. */
export function debugEntries(): DebugEntry[] {
  return entries
}

export function clearDebugLog(): void {
  entries = []
  for (const fn of subscribers) fn()
}

/** Subscribe to buffer changes; returns the unsubscribe. */
export function onDebugLog(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

let consoleHooked = false

/** Mirror console.error/console.warn into the buffer (idempotent). */
export function hookConsole(): void {
  if (consoleHooked) return
  consoleHooked = true
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try {
        const text = args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ')
        debugLog(`console.${level}`, text)
      } catch { /* diagnostics must never break the app */ }
    }
  }
}
