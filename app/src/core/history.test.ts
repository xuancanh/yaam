import { describe, expect, it } from 'vitest'
import { createHistoryEntry, prependHistory, HISTORY_CAP } from './history'

const entry = (text: string, at?: number) => createHistoryEntry({
  category: 'action', actor: 'user', kind: 'send', text, at,
})

describe('activity history', () => {
  it('prepends newest-first and tolerates an undefined log', () => {
    const approved = createHistoryEntry({ category: 'decision', actor: 'user', kind: 'approve', text: 'ok' })
    const a = prependHistory(undefined, approved)
    expect(a).toHaveLength(1)
    expect(a[0].kind).toBe('approve')
    expect(a[0].category).toBe('decision')

    const b = prependHistory(a, entry('npm test'))
    expect(b).toHaveLength(2)
    expect(b[0].text).toBe('npm test') // newest first
    expect(b[1]).toBe(a[0])            // prior entry preserved by reference
  })

  it('caps at HISTORY_CAP entries (oldest dropped)', () => {
    let log: ReturnType<typeof prependHistory> | undefined
    for (let i = 0; i < HISTORY_CAP + 50; i++) {
      log = prependHistory(log, entry(String(i), i))
    }
    expect(log).toHaveLength(HISTORY_CAP)
    expect(log![0].text).toBe(`${HISTORY_CAP + 49}`) // newest survived
  })

  it('omits detail when absent, includes it when present', () => {
    const without = createHistoryEntry({ category: 'action', actor: 'user', kind: 'send', text: 'x' })
    expect('detail' in without).toBe(false)
    const withDetail = createHistoryEntry({ category: 'decision', actor: 'user', kind: 'deny', text: 'x', detail: 'because' })
    expect(withDetail.detail).toBe('because')
  })

  it('stamps `at` from Date.now() when not supplied', () => {
    const before = Date.now()
    const entry = createHistoryEntry({ category: 'action', actor: 'user', kind: 'stop', text: 'stopped' })
    const after = Date.now()
    expect(entry.at).toBeGreaterThanOrEqual(before)
    expect(entry.at).toBeLessThanOrEqual(after)
  })

  it('coalesces identical leading progress without collapsing intervening actions', () => {
    const progress = () => createHistoryEntry({ category: 'work', actor: 'session', kind: 'progress', text: 'Running tests' })
    const once = prependHistory(undefined, progress(), { coalesce: true })
    const twice = prependHistory(once, progress(), { coalesce: true })
    expect(twice).toHaveLength(1)
    const action = prependHistory(twice, entry('continue'))
    expect(prependHistory(action, progress(), { coalesce: true })).toHaveLength(3)
  })
})
