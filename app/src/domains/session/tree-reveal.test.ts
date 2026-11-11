import { describe, expect, it } from 'vitest'
import { ancestorDirs } from './tree-reveal'

describe('ancestorDirs', () => {
  it('lists folders between the root and the file, shallowest first', () => {
    expect(ancestorDirs('/w/repo', '/w/repo/src/a/b.ts')).toEqual(['/w/repo/src', '/w/repo/src/a'])
  })
  it('is empty for a file directly under the root (trailing slash tolerated)', () => {
    expect(ancestorDirs('/w/repo/', '/w/repo/README.md')).toEqual([])
  })
  it('falls back to every ancestor when the root is a tilde path', () => {
    expect(ancestorDirs('~', '/Users/me/x/y.txt')).toEqual(['/Users', '/Users/me', '/Users/me/x'])
  })
})
