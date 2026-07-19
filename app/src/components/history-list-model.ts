import type { HistoryEntry } from '../core/types'

/** Unique task/session labels for the context strip above an activity list. */
export function historyContextIndex(entries: HistoryEntry[], scope: 'session' | 'task') {
  const seen = new Set<string>()
  return entries.flatMap(e => {
    const id = scope === 'session' ? (e.taskId ?? e.taskTitle) : e.sessionId
    const label = scope === 'session' ? e.taskTitle : e.sessionName
    if (!id || !label || seen.has(id)) return []
    seen.add(id)
    return [{ id, label }]
  })
}
