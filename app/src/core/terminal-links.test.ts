import { describe, it, expect } from 'vitest'
import { filePathMatches, resolveTermPath } from './terminal-links'

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

  it('ignores the path-looking tail of a URL (web-links addon owns those)', () => {
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
