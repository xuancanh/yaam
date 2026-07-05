// Lightweight runtime validation for IPC responses. TypeScript casts on invoke()
// results are compile-time only — a backend/serde bug or version skew can return
// a shape the cast lies about, surfacing later as a confusing downstream crash.
// These guards fail fast at the boundary with a clear, adapter-attributed error.

/** Assert a value is an array (of unknown elements). */
export function expectArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: expected an array from the backend, got ${describe(value)}`)
  }
  return value
}

/** Assert a value is a plain object with the given required keys present. */
export function expectObject(value: unknown, keys: string[], where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object from the backend, got ${describe(value)}`)
  }
  const obj = value as Record<string, unknown>
  for (const k of keys) {
    if (!(k in obj)) throw new Error(`${where}: backend response is missing "${k}"`)
  }
  return obj
}

/** Validate every element of an array is an object with the given keys. */
export function expectObjectArray(value: unknown, keys: string[], where: string): Record<string, unknown>[] {
  const arr = expectArray(value, where)
  return arr.map((el, i) => expectObject(el, keys, `${where}[${i}]`))
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
