import { describe, it, expect } from 'vitest'
import { shallowEqual, shallowEqualIgnoringOutput, sameAgentsIgnoringOutput } from './hooks'
import type { Agent } from '../core/types'

describe('shallowEqual', () => {
  it('treats identical references and primitives as equal', () => {
    const o = { a: 1 }
    expect(shallowEqual(o, o)).toBe(true)
    expect(shallowEqual(1, 1)).toBe(true)
    expect(shallowEqual('x', 'x')).toBe(true)
  })

  it('compares object slices one level deep', () => {
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
  })

  it('is false when keys differ in count', () => {
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('does NOT recurse — nested objects compare by reference', () => {
    expect(shallowEqual({ a: { n: 1 } }, { a: { n: 1 } })).toBe(false)
    const shared = { n: 1 }
    expect(shallowEqual({ a: shared }, { a: shared })).toBe(true)
  })

  it('handles null/undefined without throwing', () => {
    expect(shallowEqual(null, null)).toBe(true)
    expect(shallowEqual(null, { a: 1 } as unknown as null)).toBe(false)
    expect(shallowEqual(undefined, undefined)).toBe(true)
  })
})

describe('sameAgentsIgnoringOutput', () => {
  const base = { id: 'a', name: 'A', status: 'running', log: [], used: 1, cost: 0 } as unknown as Agent
  it('ignores output churn but sees status, name and membership changes', () => {
    expect(sameAgentsIgnoringOutput([base], [{ ...base, log: [{ t: 'out', x: 'hi' }], used: 2, cost: 0.1 } as Agent])).toBe(true)
    expect(sameAgentsIgnoringOutput([base], [{ ...base, status: 'needs' } as Agent])).toBe(false)
    expect(sameAgentsIgnoringOutput([base], [{ ...base, name: 'B' } as Agent])).toBe(false)
    expect(sameAgentsIgnoringOutput([base], [base, { ...base, id: 'b' } as Agent])).toBe(false)
  })
  it('applies inside shallowEqualIgnoringOutput only for the agents key', () => {
    const t = [] as unknown[]
    expect(shallowEqualIgnoringOutput({ agents: [base], tasks: t }, { agents: [{ ...base, used: 9 } as Agent], tasks: t })).toBe(true)
    expect(shallowEqualIgnoringOutput({ agents: [base], tasks: t }, { agents: [base], tasks: [] })).toBe(false)
  })
})
