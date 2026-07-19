// Durable per-session / per-task activity. IDs and timestamps are created
// BEFORE state updates; prependHistory is a pure reducer operation. This keeps
// state updaters replay-safe under React StrictMode.
import type { HistoryActor, HistoryEntry, HistoryEventKind, HistoryFileChange } from './entities'
import { mkId } from '../shared/id'

/** Newest-first cap. Matches the harnessLog budget so a busy session/task never
 *  grows unbounded on disk. */
export const HISTORY_CAP = 200

export interface HistoryInput {
  category: HistoryEntry['category']
  actor: HistoryActor
  kind: HistoryEventKind
  /** one-line summary shown in the history list */
  text: string
  /** optional longer context (prompt text, chosen option, comment) */
  detail?: string
  sessionId?: string
  sessionName?: string
  taskId?: string
  taskTitle?: string
  changes?: HistoryFileChange[]
  /** epoch ms; defaults to now (overridable for tests) */
  at?: number
}

/** Create an immutable event outside a store updater. */
export function createHistoryEntry(input: HistoryInput): HistoryEntry {
  const entry: HistoryEntry = {
    id: mkId('h'),
    at: input.at ?? Date.now(),
    category: input.category,
    actor: input.actor,
    kind: input.kind,
    text: input.text,
  }
  if (input.detail) entry.detail = input.detail
  if (input.sessionId) entry.sessionId = input.sessionId
  if (input.sessionName) entry.sessionName = input.sessionName
  if (input.taskId) entry.taskId = input.taskId
  if (input.taskTitle) entry.taskTitle = input.taskTitle
  if (input.changes?.length) entry.changes = input.changes
  return entry
}

function sameEvent(a: HistoryEntry, b: HistoryEntry): boolean {
  return a.actor === b.actor && a.kind === b.kind && a.text === b.text
    && a.sessionId === b.sessionId && a.taskId === b.taskId
}

/** Prepend a pre-built event (newest first, capped). `coalesce` replaces an
 *  identical leading milestone instead of filling the log with status polls. */
export function prependHistory(
  log: HistoryEntry[] | undefined,
  entry: HistoryEntry,
  options?: { coalesce?: boolean },
): HistoryEntry[] {
  const previous = log ?? []
  if (options?.coalesce && previous[0] && sameEvent(previous[0], entry)) {
    return [entry, ...previous.slice(1)].slice(0, HISTORY_CAP)
  }
  return [entry, ...previous].slice(0, HISTORY_CAP)
}
