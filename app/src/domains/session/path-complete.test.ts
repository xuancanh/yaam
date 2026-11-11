import { describe, expect, it } from 'vitest'
import { folderSuggestions, splitForComplete } from './path-complete'

describe('splitForComplete', () => {
  it('splits at the last slash', () => {
    expect(splitForComplete('~/')).toEqual({ dir: '~/', prefix: '' })
    expect(splitForComplete('~/a')).toEqual({ dir: '~/', prefix: 'a' })
    expect(splitForComplete('/Users/me/wo')).toEqual({ dir: '/Users/me/', prefix: 'wo' })
  })
  it('treats a bare ~ as home and a bare word as nothing', () => {
    expect(splitForComplete('~')).toEqual({ dir: '~/', prefix: '' })
    expect(splitForComplete('abc')).toBeNull()
  })
})

describe('folderSuggestions', () => {
  const names = ['Applications', 'apps', 'archive', 'Desktop', '.config', 'b', 'alpha', 'api', 'aws']
  it('lists only folders starting with the prefix, capped at 5', () => {
    const out = folderSuggestions('~/', 'a', names)
    expect(out).toHaveLength(5)
    expect(out.every(p => /^~\/a/i.test(p))).toBe(true)
    expect(out[0]).toBe('~/alpha/')
  })
  it('hides dot-folders unless the prefix starts with a dot', () => {
    expect(folderSuggestions('~/', '', names)).not.toContain('~/.config/')
    expect(folderSuggestions('~/', '.', names)).toEqual(['~/.config/'])
  })
})
