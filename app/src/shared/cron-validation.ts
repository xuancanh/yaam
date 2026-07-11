export type CronValidationError = 'count' | 'syntax' | 'range'

/** Validate the five fields and numeric bounds supported by YAAM's cron matcher. */
export function cronValidationError(expr: string): CronValidationError | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return 'count'
  const okField = (x: string) => /^(\*|\*\/\d+|\d+(-\d+)?)(,(\d+(-\d+)?|\*\/\d+))*$/.test(x)
  if (!fields.every(okField)) return 'syntax'
  const inBounds = (field: string, low: number, high: number) => field.split(',').every(part => {
    if (part === '*') return true
    const step = part.match(/^\*\/(\d+)$/)
    if (step) return Number(step[1]) > 0
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      return start >= low && end <= high && start <= end
    }
    const value = Number(part)
    return value >= low && value <= high
  })
  const [min, hour, dom, mon, dow] = fields
  return inBounds(min, 0, 59) && inBounds(hour, 0, 23) && inBounds(dom, 1, 31)
    && inBounds(mon, 1, 12) && inBounds(dow, 0, 6)
    ? null
    : 'range'
}
