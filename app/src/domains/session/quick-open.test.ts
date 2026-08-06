import { describe, expect, it } from 'vitest'
import { filterPaths, fuzzyScore } from './quick-open'

describe('fuzzyScore', () => {
  it('returns null when the query is not an ordered subsequence', () => {
    expect(fuzzyScore('xyz', 'src/main.ts')).toBeNull()
    // right letters, wrong order
    expect(fuzzyScore('tsm', 'src/main.ts')).toBeNull()
  })

  it('matches a subsequence across path segments', () => {
    expect(fuzzyScore('srmnts', 'src/main.ts')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('README', 'docs/ReadMe.md')).not.toBeNull()
  })

  it('scores a contiguous hit above a scattered one', () => {
    const contiguous = fuzzyScore('main', 'src/main.ts')!
    const scattered = fuzzyScore('main', 'm/a/i/n.ts')!
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('prefers a match at the basename start over one in a directory', () => {
    const inBasename = fuzzyScore('app', 'src/app.ts')!
    const inDir = fuzzyScore('app', 'app/util.ts')!
    expect(inBasename).toBeGreaterThan(inDir)
  })

  it('prefers a match anchored earlier in the path', () => {
    const early = fuzzyScore('ab', 'ab/long-name.ts')!
    const late = fuzzyScore('ab', 'long-name/ab.ts')!
    expect(early).toBeGreaterThan(late)
  })
})

describe('filterPaths', () => {
  const files = [
    'src/main.ts',
    'src/app.ts',
    'app/util.ts',
    'docs/app-guide.md',
    'package.json',
  ]

  it('returns the input order (capped) for an empty query', () => {
    expect(filterPaths('', files)).toEqual(files)
    expect(filterPaths('   ', files, 2)).toEqual(['src/main.ts', 'src/app.ts'])
  })

  it('ranks by score, breaking ties toward shorter paths', () => {
    const out = filterPaths('app', files)
    // exact basename match wins; a basename-start match beats a directory one
    expect(out[0]).toBe('src/app.ts')
    expect(out.indexOf('docs/app-guide.md')).toBeLessThan(out.indexOf('app/util.ts'))
    // non-matches are dropped
    expect(out).not.toContain('package.json')
  })

  it('honors the limit', () => {
    expect(filterPaths('a', files, 2)).toHaveLength(2)
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPaths('zzz', files)).toEqual([])
  })
})
