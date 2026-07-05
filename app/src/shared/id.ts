// Short UI identifiers with a readable entity prefix.
let uid = 0
export function mkId(prefix: string): string {
  uid += 1
  return `${prefix}${Date.now()}-${uid}`
}
