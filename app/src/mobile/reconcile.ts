// Structural sharing for pushed snapshots: every push is a fresh JSON parse,
// so without this every object is new and every row re-renders (and every
// memo misses) several times a second. reconcile() hands back the PREVIOUS
// object wherever the new value is deep-equal, so unchanged sessions, chats
// and messages keep their identity and memoized rows skip rendering.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function reconcile<T>(prev: T, next: T): T {
  return merge(prev as Json, next as Json) as T
}

function merge(prev: Json | undefined, next: Json): Json {
  if (prev === next) return prev
  if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next
    // lists here are id-keyed (sessions, msgs, tasks): match by id so an
    // insert at the front does not defeat sharing for everything after it
    const byId = new Map<unknown, Json>()
    for (const p of prev) if (p && typeof p === 'object' && !Array.isArray(p) && 'id' in p) byId.set(p.id, p)
    let same = prev.length === next.length
    const out = next.map((n, i) => {
      const base = n && typeof n === 'object' && !Array.isArray(n) && 'id' in n && byId.has(n.id) ? byId.get(n.id) : prev[i]
      const m = merge(base, n)
      if (m !== prev[i]) same = false
      return m
    })
    return same ? prev : out
  }
  if (Array.isArray(prev)) return next
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(prev).length
  const out: { [k: string]: Json } = {}
  for (const k of keys) {
    const m = merge(prev[k], next[k])
    if (m !== prev[k]) same = false
    out[k] = m
  }
  return same ? prev : out
}
