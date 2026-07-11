import { describe, expect, it } from 'vitest'
import { parseAgentIndex, resolveAgentUrl } from './agent-market'
import { exportRecord, parseAgentExport } from './agent-templates'
import type { DurableAgent } from '../../core/types'

describe('parseAgentIndex', () => {
  it('reads valid entries and drops junk', () => {
    const out = parseAgentIndex({
      agents: [
        { name: 'Captain', role: 'ships', icon: '🚢', description: 'releases', url: 'agents/captain.agent.json' },
        { name: '', url: 'x.json' }, // no name
        { name: 'NoUrl' }, // no url
        'garbage',
        null,
      ],
    })
    expect(out).toEqual([{ name: 'Captain', role: 'ships', icon: '🚢', description: 'releases', url: 'agents/captain.agent.json' }])
  })
  it('tolerates indexes without an agents array (addon-only registries)', () => {
    expect(parseAgentIndex({ packages: [] })).toEqual([])
    expect(parseAgentIndex(null)).toEqual([])
    expect(parseAgentIndex({ agents: 'nope' })).toEqual([])
  })
  it('caps field lengths', () => {
    const [a] = parseAgentIndex({ agents: [{ name: 'x'.repeat(200), url: 'u.json', description: 'y'.repeat(900) }] })
    expect(a.name).toHaveLength(60)
    expect(a.description).toHaveLength(300)
  })
})

describe('resolveAgentUrl', () => {
  it('keeps absolute urls and joins relative ones onto the index directory', () => {
    expect(resolveAgentUrl('https://x.test/a.json', 'https://r.test/index.json')).toBe('https://x.test/a.json')
    expect(resolveAgentUrl('./agents/a.json', 'https://r.test/reg/index.json')).toBe('https://r.test/reg/agents/a.json')
    expect(resolveAgentUrl('agents/a.json', '/local/reg/index.json')).toBe('/local/reg/agents/a.json')
    expect(resolveAgentUrl('/abs/a.json', '/local/reg/index.json')).toBe('/abs/a.json')
  })
})

describe('AgentExport dashboard + apps round trip', () => {
  const agent = {
    id: 'da1', name: 'Captain', color: '#6FA8FF', charter: 'ship it', createdAt: 1,
    dashboard: '## status\nok', dashboardAt: 5,
    apps: [{ id: 'app1', name: 'Checklist', description: 'gates', html: '<!doctype html><html></html>', updatedAt: 5 }],
  } as DurableAgent

  it('exports and re-parses the home-page state', () => {
    const parsed = parseAgentExport(JSON.stringify(exportRecord(agent, [])))!
    expect(parsed.dashboard).toBe('## status\nok')
    expect(parsed.apps).toEqual([{ name: 'Checklist', description: 'gates', html: '<!doctype html><html></html>' }])
  })
  it('drops invalid apps and caps the list', () => {
    const parsed = parseAgentExport(JSON.stringify({
      yaamAgent: 1, name: 'A',
      apps: [
        { name: 'ok', html: '<p>x</p>' },
        { name: '', html: '<p>y</p>' }, // no name
        { name: 'nohtml' },
        ...Array.from({ length: 20 }, (_, i) => ({ name: `bulk-${i}`, html: '<p>z</p>' })),
      ],
    }))!
    expect(parsed.apps).toHaveLength(12)
    expect(parsed.apps![0]).toEqual({ name: 'ok', description: undefined, html: '<p>x</p>' })
  })
  it('ignores a blank dashboard', () => {
    const parsed = parseAgentExport(JSON.stringify({ yaamAgent: 1, name: 'A', dashboard: '   ' }))!
    expect(parsed.dashboard).toBeUndefined()
  })
})
