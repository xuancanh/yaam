import { describe, expect, it } from 'vitest'
import { reconcile } from './reconcile'

describe('reconcile', () => {
  it('returns the previous object when nothing changed', () => {
    const a = { ts: 1, sessions: [{ id: 's1', name: 'a' }], master: { msgs: [] } }
    const b = JSON.parse(JSON.stringify(a))
    expect(reconcile(a, b)).toBe(a)
  })

  it('keeps unchanged branches and replaces changed ones', () => {
    const a = { ts: 1, sessions: [{ id: 's1', name: 'a' }, { id: 's2', name: 'b' }], chats: [{ id: 'c', msgs: [{ id: 'm', text: 'x' }] }] }
    const b = JSON.parse(JSON.stringify(a))
    b.ts = 2
    b.sessions[1].name = 'B'
    const r = reconcile(a, b)
    expect(r).not.toBe(a)
    expect(r.ts).toBe(2)
    expect(r.chats).toBe(a.chats)
    expect(r.sessions[0]).toBe(a.sessions[0])
    expect(r.sessions[1]).not.toBe(a.sessions[1])
    expect(r.sessions[1].name).toBe('B')
  })

  it('matches list items by id across inserts', () => {
    const a = { msgs: [{ id: 'm1', text: 'one' }, { id: 'm2', text: 'two' }] }
    const b = { msgs: [{ id: 'm0', text: 'zero' }, { id: 'm1', text: 'one' }, { id: 'm2', text: 'two' }] }
    const r = reconcile(a, b)
    expect(r.msgs[1]).toBe(a.msgs[0])
    expect(r.msgs[2]).toBe(a.msgs[1])
    expect(r.msgs).toHaveLength(3)
  })

  it('handles removed keys and type changes', () => {
    const a = { x: { y: 1 }, z: [1, 2] } as Record<string, unknown>
    const b = { x: 'now a string', z: [1] } as Record<string, unknown>
    expect(reconcile(a, b)).toEqual(b)
    expect(reconcile({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 })
  })
})
