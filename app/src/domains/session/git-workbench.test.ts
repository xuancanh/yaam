// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildTree, splitUnifiedDiff } from './GitPanel'

describe('buildTree', () => {
  it('nests files under depth-indented directory rows, sorted by path', () => {
    const rows = buildTree([
      { path: 'src/app/main.ts', status: 'M', staged: false },
      { path: 'README.md', status: '??', staged: false },
      { path: 'src/util.ts', status: 'A', staged: false },
    ])
    expect(rows.map(r => `${'  '.repeat(r.depth)}${r.isDir ? `${r.label}/` : r.label}`)).toEqual([
      'README.md',
      'src/',
      '  app/',
      '    main.ts',
      '  util.ts',
    ])
    expect(rows.filter(r => !r.isDir).every(r => r.file)).toBe(true)
  })

  it('keeps staged and unstaged rows keyed apart (a file can be in both sections)', () => {
    const staged = buildTree([{ path: 'a.ts', status: 'M', staged: true }])
    const unstaged = buildTree([{ path: 'a.ts', status: 'M', staged: false }])
    expect(staged[0].key).not.toBe(unstaged[0].key)
  })
})

describe('splitUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/docs/b.md b/docs/b.md',
    '+++ b/docs/b.md',
    '+added line',
  ].join('\n')

  it('splits per file with paths from the b/ side, keeping each chunk intact', () => {
    const parts = splitUnifiedDiff(diff)
    expect(parts.map(p => p.path)).toEqual(['src/a.ts', 'docs/b.md'])
    expect(parts[0].diff).toContain('-old')
    expect(parts[0].diff).not.toContain('added line')
    expect(parts[1].diff).toContain('+added line')
  })

  it('returns [] for an empty diff', () => {
    expect(splitUnifiedDiff('')).toEqual([])
  })
})
