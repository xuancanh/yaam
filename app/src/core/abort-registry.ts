// Keyed AbortControllers for cancelling per-key in-flight async work (a session's
// monitor turn, a task watcher, a chat reply, an addon agent…). When the owner is
// deleted, abort(key) cancels its running LLM request instead of leaving it to
// finish against state that no longer exists. Zero React coupling.
export class AbortRegistry {
  private controllers = new Map<string, AbortController>()

  /** The current signal for `key`, creating a fresh controller if none is active. */
  signal(key: string): AbortSignal {
    let c = this.controllers.get(key)
    if (!c) { c = new AbortController(); this.controllers.set(key, c) }
    return c.signal
  }

  /** Abort `key`'s in-flight work and forget it. */
  abort(key: string): void {
    this.controllers.get(key)?.abort()
    this.controllers.delete(key)
  }

  /** Drop a key's controller WITHOUT aborting — its work finished cleanly. */
  clear(key: string): void {
    this.controllers.delete(key)
  }

  /** Abort every tracked key (teardown). */
  abortAll(): void {
    for (const c of this.controllers.values()) c.abort()
    this.controllers.clear()
  }
}

/** True if an error is (or was caused by) an AbortController abort. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}
