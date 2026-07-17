import { describe, expect, it } from 'vitest'
import { groupRows, LAYOUT_VARIANTS, MAX_PANES, mkGroup } from './layout-state'

describe('LAYOUT_VARIANTS', () => {
  it('covers every pane count up to the cap, each variant summing to its count', () => {
    for (let n = 1; n <= MAX_PANES; n++) {
      const variants = LAYOUT_VARIANTS[n]
      expect(variants?.length, `count ${n}`).toBeGreaterThan(0)
      for (const v of variants) {
        expect(v.rows.reduce((a, b) => a + b, 0), `${n}: ${v.label}`).toBe(n)
        expect(v.rows.every(r => r >= 1)).toBe(true)
      }
    }
  })
})

describe('groupRows', () => {
  const g = (slots: number, over: { stacked?: boolean; rows?: number[] } = {}) => ({
    slots: Array(slots).fill(null) as (string | null)[],
    stacked: over.stacked ?? false,
    rows: over.rows,
  })

  it('returns a stored partition when it matches the slot count', () => {
    expect(groupRows(g(3, { rows: [1, 2] }))).toEqual([1, 2])
    expect(groupRows(g(6, { rows: [2, 2, 2] }))).toEqual([2, 2, 2])
  })

  it('falls back to the legacy derivation when rows are absent or stale', () => {
    expect(groupRows(g(1))).toEqual([1])
    expect(groupRows(g(2))).toEqual([2])
    expect(groupRows(g(2, { stacked: true }))).toEqual([1, 1])
    expect(groupRows(g(3))).toEqual([2, 1])
    expect(groupRows(g(4))).toEqual([2, 2])
    // stale partition from before a pane was closed → count default
    expect(groupRows(g(3, { rows: [2, 2] }))).toEqual([2, 1])
    expect(groupRows(g(5))).toEqual([2, 3])
    expect(groupRows(g(6))).toEqual([3, 3])
  })
})

describe('mkGroup', () => {
  it('caps slots at MAX_PANES and stores an explicit partition', () => {
    const g = mkGroup(Array(9).fill(null), false, [3, 3])
    expect(g.slots).toHaveLength(MAX_PANES)
    expect(g.rows).toEqual([3, 3])
    expect(mkGroup(['a']).rows).toBeUndefined()
  })
})
