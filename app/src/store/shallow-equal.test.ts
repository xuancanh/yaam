import { describe, it, expect } from 'vitest'
import { shallowEqual } from './hooks'

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
