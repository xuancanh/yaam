import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendBrainFile, journalEntry, knowledgeSearchCommand, LESSONS_FILE, rankKnowledgeHits } from './durable-brain'
import { exportRecord, parseAgentExport } from './agent-templates'
import type { DurableAgent } from '../../core/types'

const native = vi.hoisted(() => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }))

vi.mock('../../core/native', async importOriginal => ({
  ...await importOriginal<typeof import('../../core/native')>(),
  readTextFile: native.readTextFile,
  writeTextFile: native.writeTextFile,
}))

describe('appendBrainFile', () => {
  const agent = { id: 'a', name: 'Chef', charter: 'cook', homeDir: '/agents/chef', createdAt: 1 } as DurableAgent
  let stored = ''

  beforeEach(() => {
    stored = ''
    native.readTextFile.mockReset().mockImplementation(async () => stored)
    native.writeTextFile.mockReset().mockImplementation(async (_path, text) => { stored = text })
  })

  it('serializes concurrent learning so neither entry is overwritten', async () => {
    await Promise.all([
      appendBrainFile(agent, LESSONS_FILE, '- use less salt'),
      appendBrainFile(agent, LESSONS_FILE, '- ask about allergies'),
    ])

    expect(stored).toContain('- use less salt')
    expect(stored).toContain('- ask about allergies')
  })

  it('bounds even a single oversized entry while retaining its newest tail', async () => {
    await appendBrainFile(agent, LESSONS_FILE, `- ${'x'.repeat(70_000)}END`)

    expect(stored.length).toBeLessThanOrEqual(60_000)
    expect(stored).toContain('# Lessons')
    expect(stored).toContain('END')
  })
})

describe('knowledgeSearchCommand', () => {
  it('builds a case-insensitive alternation over tokens, .git excluded, bounded', () => {
    const cmd = knowledgeSearchCommand('/home/u/agents/chef/', 'carbonara salt kids')!
    expect(cmd).toContain(`grep -rin`)
    expect(cmd).toContain(`--exclude-dir=.git`)
    expect(cmd).toContain(`'carbonara|salt|kids'`)
    expect(cmd).toContain(`'/home/u/agents/chef'`)
    expect(cmd).toContain('head -80')
  })
  it('strips punctuation into plain tokens and rejects empty queries', () => {
    // the tokenizer keeps letters/digits/_/- only, so no regex metacharacters
    // survive into the grep pattern
    expect(knowledgeSearchCommand('/d', 'c++ (fast) meal-plan')).toContain(`'fast|meal-plan'`)
    expect(knowledgeSearchCommand('/d', ' ! ')).toBeNull()
  })
})

describe('rankKnowledgeHits', () => {
  it('ranks by token hits, strips the home prefix, and truncates long lines', () => {
    const out = [
      '/d/knowledge/pasta.md:3: carbonara needs less salt',
      '/d/knowledge/pantry.md:1: salt is in the top drawer',
      `/d/notes.md:9: ${'x'.repeat(300)} salt carbonara`,
    ].join('\n')
    const hits = rankKnowledgeHits(out, 'carbonara salt', '/d/')
    expect(hits[0]).toContain('knowledge/pasta.md:3')
    expect(hits.some(h => h.endsWith('…'))).toBe(true)
    expect(hits.every(h => !h.startsWith('/d/'))).toBe(true)
  })
})

describe('journalEntry', () => {
  it('stamps the date and conversation name', () => {
    expect(journalEntry('menu planning', 'did things', new Date('2026-07-10T12:00:00Z')))
      .toBe('## 2026-07-10 — menu planning\ndid things')
  })
})

describe('AGENT.json round-trip', () => {
  const agent = { id: 'a', name: 'Chef', role: 'cooking', color: '#FFB020', charter: 'cook well', createdAt: 1 } as DurableAgent
  it('exports and re-parses the profile with loops', () => {
    const rec = exportRecord(agent, [{ name: 'plan', schedule: '0 17 * * 0', prompt: 'plan meals' }])
    const parsed = parseAgentExport(JSON.stringify(rec))!
    expect(parsed.name).toBe('Chef')
    expect(parsed.charter).toBe('cook well')
    expect(parsed.loops).toEqual([{ name: 'plan', schedule: '0 17 * * 0', prompt: 'plan meals' }])
  })
  it('rejects non-agent json and junk', () => {
    expect(parseAgentExport('{"foo":1}')).toBeNull()
    expect(parseAgentExport('not json')).toBeNull()
    expect(parseAgentExport(JSON.stringify({ yaamAgent: 1, name: '  ' }))).toBeNull()
  })
  it('sanitizes presentation data and drops invalid imported loops', () => {
    const parsed = parseAgentExport(JSON.stringify({
      yaamAgent: 1, name: 'Agent', color: 'url(https://example.test/leak)',
      loops: [
        { name: 'good', schedule: '0 9 * * 1-5', prompt: 'work' },
        { name: 'bad-time', schedule: '99 25 * * *', prompt: 'never runs' },
        { name: 'empty', schedule: '0 9 * * *', prompt: '  ' },
      ],
    }))!

    expect(parsed.color).toBe('#B78AF7')
    expect(parsed.loops).toEqual([{ name: 'good', schedule: '0 9 * * 1-5', prompt: 'work' }])
  })
})
