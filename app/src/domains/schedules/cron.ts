// Cron expression matching and display (5-field expressions).

// Matches one field of a five-field cron expression: *, */n, a, a-b, and comma lists.
/** Match one cron field, supporting wildcards, steps, lists, and ranges. */
export function fieldMatches(field: string, value: number): boolean {
  return field.split(',').some(part => {
    if (part === '*') return true
    const step = part.match(/^\*\/(\d+)$/)
    if (step) {
      const n = parseInt(step[1], 10)
      return n > 0 && value % n === 0 // */0 never matches instead of crashing on modulo
    }
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) return value >= parseInt(range[1], 10) && value <= parseInt(range[2], 10)
    const n = parseInt(part, 10)
    return !Number.isNaN(n) && n === value
  })
}

/** Evaluate a five-field cron expression against a local Date. */
export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  // standard crontab rule: when BOTH day-of-month and day-of-week are
  // restricted (not *), the entry fires when EITHER matches
  const dayOk = dom !== '*' && dow !== '*'
    ? fieldMatches(dom, d.getDate()) || fieldMatches(dow, d.getDay())
    : fieldMatches(dom, d.getDate()) && fieldMatches(dow, d.getDay())
  return (
    fieldMatches(min, d.getMinutes()) &&
    fieldMatches(hour, d.getHours()) &&
    fieldMatches(mon, d.getMonth() + 1) &&
    dayOk
  )
}

/** Render common cron expressions as short labels and preserve uncommon input. */
export function humanizeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hour, , , dow] = f
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dow === '*') return `Every day · ${time}`
    if (/^\d+$/.test(dow)) return `${DAYS[parseInt(dow, 10) % 7]}s · ${time}`
  }
  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`
  return expr
}
