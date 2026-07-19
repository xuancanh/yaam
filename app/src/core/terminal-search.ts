export interface TerminalSearchPort {
  clearDecorations: () => void
  findNext: (query: string, options?: { incremental?: boolean }) => boolean
  findPrevious: (query: string, options?: { incremental?: boolean }) => boolean
}

/** SearchAddon decoration mode schedules searches after terminal writes and
 * resizes. A live PTY can reflow between those asynchronous scans, causing an
 * uncaught stale-cell exception. Selection-only searches stay synchronous so
 * the registry can catch/reset failures before they reach the app shell. */
export function runTerminalSearch(
  search: TerminalSearchPort,
  query: string,
  dir: 'next' | 'prev',
  incremental = false,
): boolean {
  if (!query) {
    search.clearDecorations()
    return false
  }
  return dir === 'next'
    ? search.findNext(query, { incremental })
    : search.findPrevious(query)
}
