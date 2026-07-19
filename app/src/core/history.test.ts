import { describe, expect, it } from 'vitest'
import { recordHistory, HISTORY_CAP } from './history'

describe('recordHistory', () => {
  it('prepends newest-first and tolerates an undefined log', () => {
    const a = recordHistory(undefined, { category: 'decision', kind: 'approve', text: 'ok' })
    expect(a).toHaveLength(1)
    expect(a[0].kind).toBe('approve')
    expect(a[0].category).toBe('decision')

    const b = recordHistory(a, { category: 'action', kind: 'send', text: 'npm test' })
    expect(b).toHaveLength(2)
    expect(b[0].text).toBe('npm test') // newest first
    expect(b[1]).toBe(a[0])            // prior entry preserved by reference
  })

  it('caps at HISTORY_CAP entries (oldest dropped)', () => {
    let log: ReturnType<typeof recordHistory> | undefined
    for (let i = 0; i < HISTORY_CAP + 50; i++) {
      log = recordHistory(log, { category: 'action', kind: 'send', text: String(i), at: i })
    }
    expect(log).toHaveLength(HISTORY_CAP)
    expect(log![0].text).toBe(`${HISTORY_CAP + 49}`) // newest survived
  })

  it('omits detail when absent, includes it when present', () => {
    const without = recordHistory(undefined, { category: 'action', kind: 'send', text: 'x' })
    expect('detail' in without[0]).toBe(false)
    const withDetail = recordHistory(undefined, { category: 'decision', kind: 'deny', text: 'x', detail: 'because' })
    expect(withDetail[0].detail).toBe('because')
  })

  it('stamps `at` from Date.now() when not supplied', () => {
    const before = Date.now()
    const entry = recordHistory(undefined, { category: 'action', kind: 'stop', text: 'stopped' })[0]
    const after = Date.now()
    expect(entry.at).toBeGreaterThanOrEqual(before)
    expect(entry.at).toBeLessThanOrEqual(after)
  })
})
