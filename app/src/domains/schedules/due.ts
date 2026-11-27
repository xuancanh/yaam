// Pure "what is due right now" collectors for the scheduler tick. Keeping the
// time-matching and one-shot/de-dup rules out of the interval effect makes them
// unit-testable against a fixed clock (per the progress-review's scheduler split
// into pure collectors + an executor). The effect keeps ownership of the side
// effects (marking fired, spawning sessions, adding board tasks).
import type { BoardTask, Cron } from '../../core/types'
import { cronMatches } from './cron'

/** How far back a late tick looks for minutes it skipped. Past this (a laptop
 *  asleep overnight) missed runs are dropped, like cron, not fired in a burst. */
export const CATCH_UP_MS = 10 * 60_000

/** Every minute after `since`'s minute up to and including `now`'s. */
function minutesSince(since: Date, now: Date): Date[] {
  const step = 60_000
  const end = Math.floor(now.getTime() / step) * step
  const from = Math.max(Math.floor(since.getTime() / step) * step + step, end - CATCH_UP_MS)
  const out: Date[] = []
  for (let t = from; t <= end; t += step) out.push(new Date(t))
  return out.length ? out : [now]
}

/** Crons in `crons` that should fire at `now` — enabled, not already fired this
 *  minute, and either a one-time `at` that has arrived or a schedule matching
 *  any minute since the previous tick (`since`). Matching only the current
 *  minute skipped a run whenever sleep or timer throttling delayed a tick past
 *  it (08:59:50 → 09:01:05 never ran a 9:00 job). */
export function collectDueSchedules(crons: Cron[], now: Date, since: Date = now): Cron[] {
  const minuteKey = now.toISOString().slice(0, 16)
  const nowMs = now.getTime()
  const minutes = minutesSince(since, now)
  return crons.filter(c => c.on && c.lastFiredMinute !== minuteKey
    && (c.at ? c.at <= nowMs : minutes.some(m => cronMatches(c.schedule, m))))
}

/** Scheduled tasks in `tasks` whose time has arrived and that have not already
 *  been assigned a session. */
export function collectDueTasks(tasks: BoardTask[], now: Date): BoardTask[] {
  const nowMs = now.getTime()
  return tasks.filter(t => !t.archived
    && t.col !== 'done'
    && t.col !== 'failed'
    && !!t.scheduleAt
    && t.scheduleAt <= nowMs
    && !t.agentId)
}
