import { describe, expect, it } from 'vitest'
import { recordTypeUse, sortByUsage } from './type-usage'

describe('agent type usage', () => {
  it('counts launches', () => {
    const u = recordTypeUse(recordTypeUse(undefined, 'codex', 1), 'codex', 2)
    expect(u.codex).toEqual({ n: 2, at: 2 })
  })

  it('sorts by launches, then recency, then configured order', () => {
    const settings = { agentTypeUsage: { codex: { n: 2, at: 5 }, omp: { n: 1, at: 9 }, gemini: { n: 1, at: 3 } } }
    const agents = [{ typeId: 'claude', kind: 'real' as const }, { typeId: 'claude', kind: 'chat' as const }]
    expect(sortByUsage(['claude', 'codex', 'gemini', 'omp', 'aider', 'shell'], settings, agents))
      .toEqual(['codex', 'omp', 'gemini', 'claude', 'aider', 'shell'])
  })
})
