// Runtime ingestion of tailed CLI transcripts (native `transcript-lines`).
// Two jobs today: keep a small ring of parsed transcript events per session
// for structured consumers (episode memory, adoption, richer status — later
// roadmap phases), and mark a session as responding when assistant events
// stream — a backup for the hook signal that also covers resumed sessions.
import type { AppState } from '../../core/types'
import { dispatch } from '../../core/store'
import { onTranscriptLines } from '../../core/native'
import type { TranscriptLinesEvent } from '../../core/native'

const RING_CAP = 100

const rings = new Map<string, Record<string, unknown>[]>()

/** Recent parsed transcript events for one session, oldest first. */
export function transcriptEventsFor(id: string): readonly Record<string, unknown>[] {
  return rings.get(id) ?? []
}

/** Drop a session's transcript ring (archive/delete). */
export function dropTranscriptEvents(id: string): void {
  rings.delete(id)
}

/** Test/teardown helper. */
export function resetTranscriptEvents(): void {
  rings.clear()
}

export interface TranscriptEventsDeps {
  stateRef: { current: AppState }
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: TranscriptLinesEvent) => void) => () => void
}

/** Apply one batch of transcript lines (exported for tests). */
export function applyTranscriptLines(deps: TranscriptEventsDeps, e: TranscriptLinesEvent): void {
  const agent = deps.stateRef.current.agents.find(a => a.id === e.agent)
  if (!agent || agent.archived) return
  let sawAssistant = false
  const ring = rings.get(e.agent) ?? []
  for (const line of e.lines) {
    let ev: unknown
    try { ev = JSON.parse(line) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    const rec = ev as Record<string, unknown>
    if (rec.type === 'assistant') sawAssistant = true
    ring.push(rec)
  }
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP)
  rings.set(e.agent, ring)
  if (sawAssistant && agent.status === 'running' && !agent.responding) {
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => (a.id === e.agent && !a.responding ? { ...a, responding: true } : a)),
    }))
  }
}

/** Subscribe to transcript batches; returns an unsubscribe function. */
export function attachTranscriptEvents(deps: TranscriptEventsDeps): () => void {
  const subscribe = deps.subscribe ?? onTranscriptLines
  return subscribe(e => applyTranscriptLines(deps, e))
}
