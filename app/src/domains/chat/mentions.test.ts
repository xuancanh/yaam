import { describe, expect, it } from 'vitest'
import { matchFiles } from './mentions'

const FILES = [
  'src/app/main.ts',
  'src/app/main.test.ts',
  'src/domains/chat/ChatPane.tsx',
  'README.md',
  'docs/chat.md',
]

describe('matchFiles', () => {
  it('ranks basename prefix over basename substring over path substring', () => {
    const hits = matchFiles(FILES, 'chat')
    // 'chat.md' and 'ChatPane.tsx' both prefix-match; shorter path wins
    expect(hits[0]).toBe('docs/chat.md')
    expect(hits[1]).toBe('src/domains/chat/ChatPane.tsx')
  })
  it('prefix beats substring', () => {
    expect(matchFiles(FILES, 'main')[0]).toBe('src/app/main.ts')
  })
  it('empty query lists everything up to the limit', () => {
    expect(matchFiles(FILES, '')).toHaveLength(FILES.length)
    expect(matchFiles(FILES, '', 2)).toHaveLength(2)
  })
  it('drops non-matches', () => {
    expect(matchFiles(FILES, 'zzz')).toEqual([])
  })
})
