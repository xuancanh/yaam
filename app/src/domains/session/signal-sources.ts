// Runtime registry of sessions with live structured signal coverage. When a
// session's CLI is feeding us real events (Claude/Kiro lifecycle hooks, the
// OpenCode server bus) — or has no TUI at all (ACP) — the regex prompt
// heuristics stand down for it and needs-input comes from the CLI itself.
// Coverage is evidence-based and decays: if events stop arriving (hooks
// removed, server gone), the scanner resumes as the safety net. Never
// persisted — a fresh app run re-earns coverage from live events.

export type StructuredSource = 'hooks' | 'opencode-bus'

/** structured events older than this no longer suppress the scanner */
export const STRUCTURED_FRESH_MS = 10 * 60 * 1000

const seen = new Map<string, { source: StructuredSource; at: number }>()

/** record one structured event observed for this session */
export const markStructuredSignal = (id: string, source: StructuredSource, now = Date.now()): void => {
  seen.set(id, { source, at: now })
}

/** the session's live structured source, if its evidence is still fresh */
export const structuredSourceOf = (id: string, now = Date.now()): StructuredSource | undefined => {
  const entry = seen.get(id)
  return entry && now - entry.at <= STRUCTURED_FRESH_MS ? entry.source : undefined
}

/** true when this session's needs-input truth comes from the CLI, not regexes:
 *  ACP sessions always (there is no TUI to scan), others while events flow */
export const hasAuthoritativeSignals = (agent: { id: string; acp?: boolean }, now = Date.now()): boolean =>
  !!agent.acp || structuredSourceOf(agent.id, now) !== undefined

/** drop a session's coverage record (archive/delete/dispose) */
export const dropStructuredSignals = (id: string): void => { seen.delete(id) }

/** full teardown (settle runtime dispose) */
export const resetStructuredSignals = (): void => { seen.clear() }
