import { describe, expect, it } from 'vitest'
import { splitDiffRows } from './diff-split'

const DIFF = [
  'diff --git a/x.ts b/x.ts',
  'index 111..222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,4 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '-const c = 3',
  '+const b = 20',
  ' const d = 4',
].join('\n')

describe('splitDiffRows', () => {
  it('pairs deletions with additions inside a run and pads the leftovers', () => {
    const rows = splitDiffRows(DIFF)
    // meta + hunk + ctx + 2 paired change rows + ctx
    expect(rows[0].left.kind).toBe('meta')
    expect(rows[1].left.kind).toBe('hunk')
    expect(rows[2]).toEqual({ left: { n: 1, text: 'const a = 1', kind: 'ctx' }, right: { n: 1, text: 'const a = 1', kind: 'ctx' } })
    expect(rows[3]).toEqual({ left: { n: 2, text: 'const b = 2', kind: 'del' }, right: { n: 2, text: 'const b = 20', kind: 'add' } })
    expect(rows[4]).toEqual({ left: { n: 3, text: 'const c = 3', kind: 'del' }, right: { text: '', kind: 'empty' } })
    expect(rows[5]).toEqual({ left: { n: 4, text: 'const d = 4', kind: 'ctx' }, right: { n: 3, text: 'const d = 4', kind: 'ctx' } })
  })
  it('tracks line numbers across multiple hunks', () => {
    const rows = splitDiffRows('@@ -10 +10 @@\n-x\n+y\n@@ -20,2 +20,2 @@\n z\n+w')
    expect(rows[1]).toEqual({ left: { n: 10, text: 'x', kind: 'del' }, right: { n: 10, text: 'y', kind: 'add' } })
    expect(rows[3].left).toEqual({ n: 20, text: 'z', kind: 'ctx' })
    expect(rows[4].right).toEqual({ n: 21, text: 'w', kind: 'add' })
  })
  it('is empty for an empty diff', () => {
    expect(splitDiffRows('')).toEqual([])
  })
})
