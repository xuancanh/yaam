// Which session the user is looking at RIGHT NOW. The active Pane (tabs mode's
// focused pane, or the Sidebar mode's selected run) registers itself; consumers
// (notifications, Master event routing) use it to stay quiet about a session
// the user is already watching first-hand. Module-level on purpose: the
// runtimes are plain factories with no React context.
let current: string | null = null

/** The mounted active pane claims/updates the watched session. */
export function setFocusedSession(id: string | null) {
  current = id
}

/** Release the claim on unmount — only if this session still holds it. */
export function clearFocusedSession(id: string) {
  if (current === id) current = null
}

/** True when the user is actively watching this session: its pane is the
 *  focused one AND the app window itself has OS focus. */
export function isUserWatching(id: string): boolean {
  return current === id && typeof document !== 'undefined' && document.hasFocus()
}
