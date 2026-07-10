import { describe, expect, it } from 'vitest'
import { appendMemory, formatHits, memoryDigest, searchMemory, wsMemory } from './assistant-memory'
import type { MemoryFile } from '../../core/types'

const file = (name: string, content: string, updatedAt = 1): MemoryFile =>
  ({ id: `f-${name}`, name, content, updatedAt })

describe('appendMemory', () => {
  it('creates the file on first write and appends as a dash line', () => {
    const once = appendMemory([], 'approvals', 'user approved network access for npm', 5)
    expect(once).toHaveLength(1)
    expect(once[0].name).toBe('approvals')
    expect(once[0].content).toBe('- user approved network access for npm')
    const twice = appendMemory(once, 'approvals', 'denied rm -rf', 6)
    expect(twice[0].content.split('\n')).toHaveLength(2)
    expect(twice[0].updatedAt).toBe(6)
  })
  it('dedupes identical lines and ignores empty entries', () => {
    const files = appendMemory([], 'notes', 'fact one')
    expect(appendMemory(files, 'notes', 'fact one')).toBe(files)
    expect(appendMemory(files, 'notes', '   ')).toBe(files)
  })
  it('drops the oldest lines past the cap', () => {
    const big = file('notes', Array.from({ length: 400 }, (_, i) => `- entry number ${i} ${'x'.repeat(20)}`).join('\n'))
    const next = appendMemory([big], 'notes', 'the newest entry')
    expect(next[0].content.length).toBeLessThanOrEqual(12_000)
    expect(next[0].content.endsWith('- the newest entry')).toBe(true)
    expect(next[0].content).not.toContain('entry number 0 ')
  })
  it('caps a single oversized entry', () => {
    const next = appendMemory([], 'notes', 'x'.repeat(20_000))
    expect(next[0].content.length).toBe(12_000)
    expect(next[0].content.startsWith('- ')).toBe(true)
    expect(next[0].content.endsWith('...')).toBe(true)
  })
})

describe('searchMemory', () => {
  const files = [
    file('approvals', '- approved network access for npm install\n- denied deleting the database', 10),
    file('preferences', '- prefers pnpm over npm\n- always run tests before commit', 20),
  ]
  it('ranks lines by token hits and tags the source file', () => {
    const hits = searchMemory(files, 'npm install network')
    expect(hits[0]).toEqual({ file: 'approvals', line: '- approved network access for npm install' })
    expect(hits.some(h => h.file === 'preferences')).toBe(true)
  })
  it('returns nothing for a no-token query', () => {
    expect(searchMemory(files, ' ! ')).toEqual([])
  })
})

describe('memoryDigest / formatHits', () => {
  it('takes the freshest lines of the requested files only, bounded', () => {
    const files = [file('approvals', '- a1\n- a2'), file('notes', '- n1')]
    const digest = memoryDigest(files, ['approvals'], 100)
    expect(digest).toContain('[approvals]')
    expect(digest).toContain('- a2')
    expect(digest).not.toContain('n1')
  })
  it('formats hits with file tags and a fallback', () => {
    expect(formatHits([{ file: 'notes', line: '- x' }])).toBe('[notes] - x')
    expect(formatHits([])).toBe('no matching memory entries')
  })
})

describe('wsMemory', () => {
  it('uses an explicit background workspace instead of the active workspace', () => {
    const active = [file('preferences', '- active')]
    const background = [file('preferences', '- background')]
    const state = {
      activeWorkspace: 'ws-a',
      assistantMemory: { 'ws-a': active, 'ws-b': background },
    }
    expect(wsMemory(state)).toBe(active)
    expect(wsMemory(state, 'ws-b')).toBe(background)
  })
})
