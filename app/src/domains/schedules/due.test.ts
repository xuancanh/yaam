import { describe, expect, it } from 'vitest'
import { collectDueSchedules, collectDueTasks } from './due'
type Cron = import('../../core/types').Cron
type BoardTask = import('../../core/types').BoardTask

const cron = (over: Partial<Cron>): Cron => ({
  id: 'c', name: 'c', schedule: '* * * * *', on: true, built: false, last: '—', ...over,
} as Cron)
const task = (over: Partial<BoardTask>): BoardTask => ({
  id: 't', title: 't', col: 'backlog', agentId: null, ...over,
} as BoardTask)

// Wed 2026-01-07 09:30 local
const now = new Date(2026, 0, 7, 9, 30)
const minuteKey = now.toISOString().slice(0, 16)

describe('collectDueSchedules', () => {
  it('returns enabled crons whose schedule matches now', () => {
    const due = collectDueSchedules([cron({ id: 'a', schedule: '30 9 * * *' }), cron({ id: 'b', schedule: '31 9 * * *' })], now)
    expect(due.map(c => c.id)).toEqual(['a'])
  })
  it('skips disabled crons and ones already fired this minute', () => {
    expect(collectDueSchedules([cron({ on: false })], now)).toEqual([])
    expect(collectDueSchedules([cron({ lastFiredMinute: minuteKey })], now)).toEqual([])
  })
  it('fires a one-time `at` schedule once its time has passed', () => {
    expect(collectDueSchedules([cron({ id: 'x', at: now.getTime() - 1000 })], now).map(c => c.id)).toEqual(['x'])
    expect(collectDueSchedules([cron({ id: 'y', at: now.getTime() + 1000 })], now)).toEqual([])
  })
})

describe('collectDueTasks', () => {
  it('returns unassigned tasks whose scheduleAt has arrived', () => {
    const due = collectDueTasks([
      task({ id: 'a', scheduleAt: now.getTime() - 1 }),
      task({ id: 'b', scheduleAt: now.getTime() + 10000 }), // future
      task({ id: 'c' }),                                     // not scheduled
    ], now)
    expect(due.map(t => t.id)).toEqual(['a'])
  })
  it('skips a scheduled task that already has a session', () => {
    expect(collectDueTasks([task({ id: 'a', scheduleAt: now.getTime() - 1, agentId: 'sess-1' })], now)).toEqual([])
  })
  it('skips archived and terminal-state tasks', () => {
    const at = now.getTime() - 1
    expect(collectDueTasks([
      task({ id: 'archived', scheduleAt: at, archived: true }),
      task({ id: 'done', scheduleAt: at, col: 'done' }),
      task({ id: 'failed', scheduleAt: at, col: 'failed' }),
    ], now)).toEqual([])
  })
})
