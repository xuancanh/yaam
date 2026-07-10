// Pure "what is due right now" collectors for the scheduler tick. Keeping the
// time-matching and one-shot/de-dup rules out of the interval effect makes them
// unit-testable against a fixed clock (per the progress-review's scheduler split
// into pure collectors + an executor). The effect keeps ownership of the side
// effects (marking fired, spawning sessions, adding board tasks).
import type { BoardTask, Cron } from '../../core/types'
import { cronMatches } from './cron'

/** Crons in `crons` that should fire at `now` — enabled, not already fired this
 *  minute, and either a one-time `at` that has arrived or a matching schedule. */
export function collectDueSchedules(crons: Cron[], now: Date): Cron[] {
  const minuteKey = now.toISOString().slice(0, 16)
  const nowMs = now.getTime()
  return crons.filter(c => c.on && c.lastFiredMinute !== minuteKey
    && (c.at ? c.at <= nowMs : cronMatches(c.schedule, now)))
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
