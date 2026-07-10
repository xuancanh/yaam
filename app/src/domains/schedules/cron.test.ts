import { describe, expect, it } from 'vitest'
import { buildCron, cronFiresOnDay, cronMatches, cronTimeLabel, describeCron, fieldMatches, humanizeCron } from './cron'

describe('fieldMatches', () => {
  it('matches wildcards, values, ranges, lists, and steps', () => {
    expect(fieldMatches('*', 5)).toBe(true)
    expect(fieldMatches('5', 5)).toBe(true)
    expect(fieldMatches('5', 6)).toBe(false)
    expect(fieldMatches('1-3', 2)).toBe(true)
    expect(fieldMatches('1,4,6', 4)).toBe(true)
    expect(fieldMatches('*/15', 30)).toBe(true)
    expect(fieldMatches('*/15', 31)).toBe(false)
  })
  it('rejects */0 and non-numeric fields instead of crashing', () => {
    expect(fieldMatches('*/0', 0)).toBe(false)
    expect(fieldMatches('abc', 5)).toBe(false)
  })
})

describe('cronMatches', () => {
  // Wed 2026-01-07 09:30 local
  const d = new Date(2026, 0, 7, 9, 30)
  it('matches an exact minute/hour', () => {
    expect(cronMatches('30 9 * * *', d)).toBe(true)
    expect(cronMatches('31 9 * * *', d)).toBe(false)
  })
  it('ORs day-of-month and day-of-week when both are restricted (crontab rule)', () => {
    // DOM=7 matches, DOW=0(Sun) does not → OR ⇒ still fires
    expect(cronMatches('30 9 7 * 0', d)).toBe(true)
    // neither DOM (8) nor DOW (0) matches ⇒ does not fire
    expect(cronMatches('30 9 8 * 0', d)).toBe(false)
  })
  it('rejects malformed expressions', () => {
    expect(cronMatches('30 9 * *', d)).toBe(false)
  })
})

describe('humanizeCron', () => {
  it('renders common shapes and preserves uncommon ones', () => {
    expect(humanizeCron('0 9 * * *')).toBe('Every day · 09:00')
    expect(humanizeCron('*/10 * * * *')).toBe('Every 10 min')
    expect(humanizeCron('weird expr')).toBe('weird expr')
  })
})

describe('describeCron', () => {
  it('explains common shapes in full sentences', () => {
    expect(describeCron('0 3 * * *')).toEqual({ ok: true, text: 'Runs at 03:00' })
    expect(describeCron('*/10 * * * *').text).toBe('Runs every 10 minutes')
    expect(describeCron('30 * * * *').text).toBe('Runs every hour at :30')
    expect(describeCron('0 9 * * 1').text).toBe('Runs at 09:00 on Monday')
    expect(describeCron('0 9 * * 1-5').text).toBe('Runs at 09:00 on Monday–Friday')
    expect(describeCron('0 0 1 * *').text).toBe('Runs at 00:00 on day 1 of the month')
    expect(describeCron('15 */2 * * *').text).toBe('Runs every 2 hours at :15')
  })
  it('spells the crontab either-day rule out', () => {
    expect(describeCron('0 9 15 * 1').text).toBe('Runs at 09:00 on day 15 of the month or on Monday')
  })
  it('flags wrong field counts and junk fields', () => {
    expect(describeCron('0 9 * *').ok).toBe(false)
    expect(describeCron('a b c d e').ok).toBe(false)
  })
  it('rejects out-of-range values, reversed ranges, and zero steps', () => {
    expect(describeCron('60 9 * * *').ok).toBe(false)
    expect(describeCron('0 24 * * *').ok).toBe(false)
    expect(describeCron('0 9 0 13 7').ok).toBe(false)
    expect(describeCron('0 9 * * 5-1').ok).toBe(false)
    expect(describeCron('*/0 * * * *').ok).toBe(false)
  })
})

describe('buildCron', () => {
  const base = { freq: 'daily', every: 5, time: '09:30', dow: 1, dom: 15 } as const
  it('compiles each frequency', () => {
    expect(buildCron({ ...base, freq: 'minutes' })).toBe('*/5 * * * *')
    expect(buildCron({ ...base, freq: 'hourly' })).toBe('30 * * * *')
    expect(buildCron({ ...base, freq: 'daily' })).toBe('30 9 * * *')
    expect(buildCron({ ...base, freq: 'weekly' })).toBe('30 9 * * 1')
    expect(buildCron({ ...base, freq: 'monthly' })).toBe('30 9 15 * *')
  })
  it('clamps junk input instead of emitting a broken expression', () => {
    expect(buildCron({ freq: 'minutes', every: 0, time: 'zz', dow: 9, dom: 40 })).toBe('*/1 * * * *')
    expect(buildCron({ freq: 'weekly', every: 5, time: '25:99', dow: 9, dom: 40 })).toBe('59 23 * * 6')
    expect(buildCron({ freq: 'monthly', every: 5, time: '09:00', dow: 1, dom: 40 })).toBe('0 9 31 * *')
  })
})

describe('cronFiresOnDay', () => {
  // Wed 2026-01-07 local
  const wed = new Date(2026, 0, 7)
  it('ignores time fields — any-minute schedules fire every day', () => {
    expect(cronFiresOnDay('*/10 * * * *', wed)).toBe(true)
    expect(cronFiresOnDay('30 9 * * *', wed)).toBe(true)
  })
  it('respects weekday and day-of-month restrictions', () => {
    expect(cronFiresOnDay('0 9 * * 3', wed)).toBe(true)
    expect(cronFiresOnDay('0 9 * * 1', wed)).toBe(false)
    expect(cronFiresOnDay('0 9 7 * *', wed)).toBe(true)
    expect(cronFiresOnDay('0 9 8 * *', wed)).toBe(false)
  })
  it('applies the either-matches rule when both day fields are set', () => {
    expect(cronFiresOnDay('0 9 8 * 3', wed)).toBe(true) // dow matches even though dom does not
    expect(cronFiresOnDay('0 9 8 * 1', wed)).toBe(false)
  })
  it('respects the month field and rejects malformed expressions', () => {
    expect(cronFiresOnDay('0 9 * 1 *', wed)).toBe(true)
    expect(cronFiresOnDay('0 9 * 2 *', wed)).toBe(false)
    expect(cronFiresOnDay('0 9 * *', wed)).toBe(false)
  })
})

describe('cronTimeLabel', () => {
  it('renders the common shapes compactly', () => {
    expect(cronTimeLabel('30 9 * * *')).toBe('09:30')
    expect(cronTimeLabel('15 * * * *')).toBe(':15 hourly')
    expect(cronTimeLabel('*/10 * * * *')).toBe('every 10 min')
    expect(cronTimeLabel('0 */2 * * *')).toBe(':00 every 2 h')
    expect(cronTimeLabel('* * * * *')).toBe('every minute')
  })
})
