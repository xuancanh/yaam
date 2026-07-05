import { describe, expect, it } from 'vitest'
import { cronMatches, fieldMatches, humanizeCron } from './cron'

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
