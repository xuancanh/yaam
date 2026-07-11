import { describe, expect, it } from 'vitest'
import { AbortRegistry, isAbortError } from './abort-registry'

describe('AbortRegistry', () => {
  it('hands out a stable signal per key until aborted', () => {
    const r = new AbortRegistry()
    const s1 = r.signal('a')
    expect(r.signal('a')).toBe(s1) // same controller reused
    expect(s1.aborted).toBe(false)
  })

  it('abort(key) aborts that key and issues a fresh signal afterward', () => {
    const r = new AbortRegistry()
    const s1 = r.signal('a')
    r.abort('a')
    expect(s1.aborted).toBe(true)
    const s2 = r.signal('a') // new controller after abort
    expect(s2).not.toBe(s1)
    expect(s2.aborted).toBe(false)
  })

  it('clear(key) forgets a key without aborting it', () => {
    const r = new AbortRegistry()
    const s1 = r.signal('a')
    r.clear('a')
    expect(s1.aborted).toBe(false)
    expect(r.signal('a')).not.toBe(s1)
  })

  it('an obsolete owner cannot clear a replacement controller', () => {
    const r = new AbortRegistry()
    const old = r.signal('a')
    r.abort('a')
    const replacement = r.signal('a')

    expect(r.clear('a', old)).toBe(false)
    expect(r.has('a')).toBe(true)
    expect(r.signal('a')).toBe(replacement)
    expect(replacement.aborted).toBe(false)
  })

  it('abortAll() aborts every tracked key', () => {
    const r = new AbortRegistry()
    const a = r.signal('a'); const b = r.signal('b')
    r.abortAll()
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(true)
  })

  it('isAbortError recognizes abort/timeout errors only', () => {
    const err = new Error('x'); err.name = 'AbortError'
    expect(isAbortError(err)).toBe(true)
    expect(isAbortError(new Error('nope'))).toBe(false)
    expect(isAbortError('string')).toBe(false)
  })
})
