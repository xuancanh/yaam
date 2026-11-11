import { describe, expect, it } from 'vitest'
import { reviewPrompt, unifiedLineNumbers } from './review-comments'

describe('unifiedLineNumbers', () => {
  it('tracks old and new line numbers through a hunk', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -10,3 +10,4 @@', ' keep', '-gone', '+new1', '+new2', ' tail'].join('\n')
    expect(unifiedLineNumbers(diff)).toEqual([
      null, null, null, null,
      { line: 10, side: 'new' }, { line: 11, side: 'old' }, { line: 11, side: 'new' }, { line: 12, side: 'new' }, { line: 13, side: 'new' },
    ])
  })
})

describe('reviewPrompt', () => {
  it('groups comments by file in line order', () => {
    const p = reviewPrompt([
      { id: '1', path: 'b.ts', line: 9, side: 'new', code: 'x()', text: 'rename' },
      { id: '2', path: 'a.ts', line: 30, side: 'new', code: 'y', text: 'why?' },
      { id: '3', path: 'a.ts', line: 3, side: 'old', code: 'z', text: 'keep this' },
    ])
    expect(p.indexOf('a.ts:')).toBeLessThan(p.indexOf('b.ts:'))
    expect(p.indexOf('line 3 (removed line)')).toBeLessThan(p.indexOf('line 30'))
  })
})
