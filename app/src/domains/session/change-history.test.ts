import { describe, expect, it } from 'vitest'
import { historyChangeLabel, parseHistoryChanges } from './change-history'

describe('session change history', () => {
  it('extracts file kinds, rename paths, and line counts from multi-repo diffs', () => {
    const changes = parseHistoryChanges([{ name: 'app', diff: [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more',
      'diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts',
      'diff --git a/logo.png b/logo.png', 'GIT binary patch',
    ].join('\n') }])
    expect(changes).toEqual([
      { path: 'app/src/a.ts', change: 'modified', additions: 2, deletions: 1 },
      { path: 'app/new.ts', from: 'app/old.ts', change: 'renamed', additions: 0, deletions: 0 },
      { path: 'app/logo.png', change: 'binary' },
    ])
    expect(historyChangeLabel(changes)).toBe('Working tree snapshot · 3 files · +2 −1')
  })

  it('skips failed repository snapshots', () => {
    expect(parseHistoryChanges([{ name: 'bad', diff: '', error: 'gone' }, { name: 'also', diff: 'error: no repo' }])).toEqual([])
  })
})
