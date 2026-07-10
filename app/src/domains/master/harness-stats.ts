// Online evaluation of the assistant harness via implicit user feedback: every
// needs-input flag, action suggestion, and quick reply is logged as a decision;
// the user's response (clicked = accepted, cleared/ignored = dismissed, typed
// something else = overridden) resolves it. Rates per role feed the Settings
// scorecard and a short calibration note injected into each role's prompt —
// the "tell the judge its own precision" technique from production LLM evals.
import type { HarnessDecision, HarnessRole } from '../../core/types'
import { mkId } from '../../shared/id'

const LOG_CAP = 200

/** Prepend one pending decision (newest first, capped). Tolerates states from
 *  before this field existed. */
export function recordDecision(
  log: HarnessDecision[] | undefined,
  d: Omit<HarnessDecision, 'id' | 'at'> & { at?: number },
): HarnessDecision[] {
  return [{ id: mkId('hd'), at: d.at ?? Date.now(), ...d }, ...(log ?? [])].slice(0, LOG_CAP)
}

/** Resolve the newest PENDING decision matching the criteria; no-op when none
 *  matches (the user acted without a preceding assistant decision). */
export function resolveDecision(
  logIn: HarnessDecision[] | undefined,
  match: { role?: HarnessRole; kind?: HarnessDecision['kind']; agentId?: string; taskId?: string },
  outcome: NonNullable<HarnessDecision['outcome']>,
  choice?: string,
): HarnessDecision[] {
  const log = logIn ?? []
  const ix = log.findIndex(d =>
    !d.outcome
    && (match.role === undefined || d.role === match.role)
    && (match.kind === undefined || d.kind === match.kind)
    && (match.agentId === undefined || d.agentId === match.agentId)
    && (match.taskId === undefined || d.taskId === match.taskId))
  if (ix < 0) return log
  return log.map((d, i) => (i === ix ? { ...d, outcome, choice } : d))
}

export interface RoleStats {
  shown: number
  accepted: number
  dismissed: number
  overridden: number
  pending: number
  /** accepted / resolved — the role's suggestion precision (null = no signal) */
  precision: number | null
}

/** Aggregate implicit-feedback rates per role. */
export function harnessStats(log: HarnessDecision[] | undefined): Record<HarnessRole, RoleStats> {
  const empty = (): RoleStats => ({ shown: 0, accepted: 0, dismissed: 0, overridden: 0, pending: 0, precision: null })
  const out: Record<HarnessRole, RoleStats> = { monitor: empty(), watcher: empty(), master: empty(), chat: empty() }
  for (const d of log ?? []) {
    const s = out[d.role]
    if (!s) continue
    s.shown += 1
    if (!d.outcome) s.pending += 1
    else if (d.outcome === 'accepted') s.accepted += 1
    else if (d.outcome === 'dismissed') s.dismissed += 1
    else s.overridden += 1
  }
  for (const role of Object.keys(out) as HarnessRole[]) {
    const s = out[role]
    const resolved = s.accepted + s.dismissed + s.overridden
    s.precision = resolved >= 3 ? s.accepted / resolved : null
  }
  return out
}

/** A one-line self-calibration note for a role's system prompt; '' until there
 *  is enough signal. Nudges over-eager roles toward precision and timid ones
 *  toward recall. */
export function calibrationNote(log: HarnessDecision[] | undefined, role: HarnessRole): string {
  const s = harnessStats(log)[role]
  const resolved = s.accepted + s.dismissed + s.overridden
  if (resolved < 5 || s.precision === null) return ''
  const pct = Math.round(s.precision * 100)
  const hint = s.precision < 0.4
    ? 'Most were not useful — be more conservative and more specific; only flag/suggest when the evidence is strong.'
    : s.precision > 0.8
      ? 'Your judgment has been reliable — keep the same bar.'
      : 'Mixed results — prefer fewer, more confident calls.'
  return `CALIBRATION: of your last ${resolved} resolved proposals, the user accepted ${pct}%. ${hint}`
}
