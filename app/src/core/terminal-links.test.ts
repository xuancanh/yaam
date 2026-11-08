import { describe, it, expect } from 'vitest'
import { filePathMatches, resolveTermPath, urlLinksAt } from './terminal-links'

const paths = (line: string) => filePathMatches(line).map(m => m.path)

describe('filePathMatches', () => {
  it('finds absolute, home, and dot-relative paths', () => {
    expect(paths('cat /etc/hosts')).toEqual(['/etc/hosts'])
    expect(paths('saved to ~/notes/todo.md')).toEqual(['~/notes/todo.md'])
    expect(paths('run ./scripts/build.sh now')).toEqual(['./scripts/build.sh'])
    expect(paths('see ../other/mod.rs')).toEqual(['../other/mod.rs'])
  })

  it('finds slashed relative paths and bare filenames with extensions', () => {
    expect(paths('modified src/domains/session/Pane.tsx')).toEqual(['src/domains/session/Pane.tsx'])
    expect(paths('edit package.json please')).toEqual(['package.json'])
  })

  it('captures a :line[:col] suffix in the link but strips it from the path', () => {
    const [m] = filePathMatches('error at src/app.ts:42:7 something')
    expect(m.path).toBe('src/app.ts')
    expect(m.line).toBe(42)
    const line = 'error at src/app.ts:42:7 something'
    expect(line.slice(m.index, m.index + m.length)).toBe('src/app.ts:42:7')
  })

  it('drops trailing sentence punctuation', () => {
    expect(paths('open src/main.rs.')).toEqual(['src/main.rs'])
    expect(paths('files: a/b.ts, c/d.ts')).toEqual(['a/b.ts', 'c/d.ts'])
  })

  it('ignores the path-looking tail of a URL (urlLinksAt owns those)', () => {
    expect(paths('visit https://example.com/deep/path.html today')).toEqual([])
  })

  it('rejects bare words and tokens glued to other text', () => {
    expect(paths('nothing here at all')).toEqual([])
    expect(paths('cwd:/no/boundary')).toEqual([])
  })

  it('accepts quoted and bracketed paths', () => {
    expect(paths('reading "src/core/data.ts" now')).toEqual(['src/core/data.ts'])
    expect(paths('(see docs/security.md)')).toEqual(['docs/security.md'])
  })
})

describe('resolveTermPath', () => {
  it('passes absolute and home paths through', () => {
    expect(resolveTermPath('/a/b.ts', '/cwd')).toBe('/a/b.ts')
    expect(resolveTermPath('~/x.md', '/cwd')).toBe('~/x.md')
  })

  it('joins relative paths onto the cwd, dropping a leading ./', () => {
    expect(resolveTermPath('src/app.ts', '/repo')).toBe('/repo/src/app.ts')
    expect(resolveTermPath('./x.sh', '/repo/')).toBe('/repo/x.sh')
    expect(resolveTermPath('x.sh', '')).toBe('x.sh')
  })
})

describe('urlLinksAt', () => {
  const COLS = 40
  const screen = (rows: (string | [string, boolean])[]) => (y: number) => {
    const r = rows[y]
    if (r === undefined) return undefined
    return typeof r === 'string' ? { text: r, wrapped: false } : { text: r[0], wrapped: r[1] }
  }

  it('finds a URL on one row', () => {
    const [l] = urlLinksAt(screen(['see https://example.com/a.']), 0, COLS)
    expect(l.url).toBe('https://example.com/a')
    expect(l.start).toEqual({ x: 5, y: 1 })
  })

  it('joins a URL a TUI hard-wrapped onto an indented next row', () => {
    const rows = screen([
      '  Open https://github.com/org/repo/pull/', // 40 chars, full row
      '  12345/files?diff=split now',
    ])
    for (const y of [0, 1]) {
      const [l] = urlLinksAt(rows, y, COLS)
      expect(l.url).toBe('https://github.com/org/repo/pull/12345/files?diff=split')
      expect(l.start).toEqual({ x: 8, y: 1 })
      expect(l.end).toEqual({ x: 24, y: 2 })
    }
  })

  it('joins three rows when the middle one is a bare fragment', () => {
    const rows = screen([
      'go: https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccc',
    ])
    expect(urlLinksAt(rows, 2, COLS)[0].url).toBe(`https://${'a'.repeat(31)}${'b'.repeat(40)}cccc`)
  })

  it('follows xterm soft wraps', () => {
    const rows = screen(['x https://example.com/aaaaaaaaaaaaaaaaaaaa', ['bbb done', true]])
    expect(urlLinksAt(rows, 1, COLS)[0].url).toBe('https://example.com/aaaaaaaaaaaaaaaaaaaabbb')
  })

  it('does not glue a short row to the next line', () => {
    const rows = screen(['see https://example.com', 'Next line'])
    expect(urlLinksAt(rows, 0, COLS)[0].url).toBe('https://example.com')
    expect(urlLinksAt(rows, 1, COLS)).toEqual([])
  })

  it('does not join when the full row ends in prose, not a URL', () => {
    const rows = screen(['https://a.io is the link and some words', 'more'])
    expect(urlLinksAt(rows, 0, COLS)[0].url).toBe('https://a.io')
  })

  it('strips box borders around wrapped text', () => {
    const rows = screen([
      '│ https://example.com/very/long/path/ │',
      '│ continued/here                      │',
    ])
    expect(urlLinksAt(rows, 1, COLS)[0].url).toBe('https://example.com/very/long/path/continued/here')
  })
})
