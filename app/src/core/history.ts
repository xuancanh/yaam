// Per-session / per-task user-action history: a newest-first, capped, append-only
// log of what the user DID (actions) and DECIDED (approvals, choices, feedback).
// Distinct from harnessLog (which scores assistant proposals) and the workspace
// activity feed (system events) — this is the user's own trail on one entity.
//
// Pure helpers, no React: call recordHistory() inside a dispatch updater, the
// same way resolveDecision/recordDecision feed the global harnessLog.
import type { HistoryEntry, HistoryEventKind } from './entities'
import { mkId } from '../shared/id'

/** Newest-first cap. Matches the harnessLog budget so a busy session/task never
 *  grows unbounded on disk. */
export const HISTORY_CAP = 200

export interface HistoryInput {
  category: 'action' | 'decision'
  kind: HistoryEventKind
  /** one-line summary shown in the history list */
  text: string
  /** optional longer context (prompt text, chosen option, comment) */
  detail?: string
  /** epoch ms; defaults to now (overridable for tests) */
  at?: number
}

/** Prepend one entry (newest first, capped). Tolerates states from before this
 *  field existed (undefined log). Pure — call from inside a dispatch updater. */
export function recordHistory(log: HistoryEntry[] | undefined, input: HistoryInput): HistoryEntry[] {
  const entry: HistoryEntry = {
    id: mkId('h'),
    at: input.at ?? Date.now(),
    category: input.category,
    kind: input.kind,
    text: input.text,
  }
  if (input.detail) entry.detail = input.detail
  return [entry, ...(log ?? [])].slice(0, HISTORY_CAP)
}
