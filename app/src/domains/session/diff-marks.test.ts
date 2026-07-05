import { describe, expect, it } from 'vitest'
import { parseDiffLines } from './diff-marks'

const arr = (s: Set<number>) => [...s].sort((a, b) => a - b)

describe('parseDiffLines', () => {
  it('marks a pure addition (old count 0) as added', () => {
    // 3 new lines added at line 10, nothing removed
    const m = parseDiffLines('@@ -9,0 +10,3 @@')
    expect(arr(m.added)).toEqual([10, 11, 12])
    expect(m.modified.size).toBe(0)
    expect(m.deletedAfter.size).toBe(0)
  })

  it('marks a replacement (both sides non-zero) as modified', () => {
    const m = parseDiffLines('@@ -5,2 +5,2 @@')
    expect(arr(m.modified)).toEqual([5, 6])
    expect(m.added.size).toBe(0)
  })

  it('records a pure deletion (new count 0) as deletedAfter', () => {
    const m = parseDiffLines('@@ -8,3 +7,0 @@')
    expect(arr(m.deletedAfter)).toEqual([7])
    expect(m.added.size).toBe(0)
    expect(m.modified.size).toBe(0)
  })

  it('treats an omitted count as 1 (single-line hunks)', () => {
    // "@@ -4 +4 @@" — one line changed in place
    expect(arr(parseDiffLines('@@ -4 +4 @@').modified)).toEqual([4])
    // "@@ -0,0 +1 @@" — one line added at 1
    expect(arr(parseDiffLines('@@ -0,0 +1 @@').added)).toEqual([1])
  })

  it('accumulates markers across multiple hunks in one diff', () => {
    const diff = [
      'diff --git a/f b/f',
      '@@ -1,0 +1,2 @@',
      '+new one',
      '+new two',
      '@@ -10,1 +12,1 @@',
      '-old',
      '+changed',
    ].join('\n')
    const m = parseDiffLines(diff)
    expect(arr(m.added)).toEqual([1, 2])
    expect(arr(m.modified)).toEqual([12])
  })

  it('returns empty marks for an empty or headerless diff', () => {
    const m = parseDiffLines('')
    expect(m.added.size + m.modified.size + m.deletedAfter.size).toBe(0)
  })
})
