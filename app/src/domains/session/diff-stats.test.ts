import { describe, expect, it } from 'vitest'
import { numstatCommand, parseNumstat, statsFromUnifiedDiff } from './diff-stats'

describe('parseNumstat', () => {
  it('sums added/removed lines and counts files', () => {
    const out = '12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n'
    expect(parseNumstat(out)).toEqual({ add: 12, del: 10, files: 2 })
  })
  it('counts binary files ("-") and untracked paths as files without line stats', () => {
    const out = '-\t-\timg.png\nnew-file.ts\n5\t0\tc.ts'
    expect(parseNumstat(out)).toEqual({ add: 5, del: 0, files: 3 })
  })
  it('is empty for empty output', () => {
    expect(parseNumstat('\n')).toEqual({ add: 0, del: 0, files: 0 })
  })
})

describe('statsFromUnifiedDiff', () => {
  it('counts files by diff headers and +/- lines, skipping ---/+++ markers', () => {
    const diff = [
      'diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1,2 @@', '+one', '+two', '-gone',
      'diff --git a/y b/y', '+++ b/y', '+only',
    ].join('\n')
    expect(statsFromUnifiedDiff(diff)).toEqual({ add: 3, del: 1, files: 2 })
  })
})

describe('numstatCommand', () => {
  it('diffs vs HEAD and appends untracked files, quoted for the shell', () => {
    const cmd = numstatCommand('/re po')
    expect(cmd).toContain(`git -C '/re po' diff --numstat HEAD`)
    expect(cmd).toContain('ls-files --others --exclude-standard')
  })
})
