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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Explain one cron field in words for the day/month positions. */
function fieldWords(field: string, names?: string[]): string {
  return field.split(',').map(part => {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) return `${names ? names[+range[1] % 7] : range[1]}–${names ? names[+range[2] % 7] : range[2]}`
    const step = part.match(/^\*\/(\d+)$/)
    if (step) return `every ${step[1]}`
    return names ? names[+part % 7] ?? part : part
  }).join(', ')
}

/** Full plain-English meaning of a 5-field cron expression, with an explicit
 *  invalid state — the live hint under the schedule editor. */
export function describeCron(expr: string): { ok: boolean; text: string } {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return { ok: false, text: 'needs 5 fields: minute · hour · day-of-month · month · weekday' }
  const [min, hour, dom, mon, dow] = f
  const okField = (x: string) => /^(\*|\*\/\d+|\d+(-\d+)?)(,(\d+(-\d+)?|\*\/\d+))*$/.test(x)
  if (![min, hour, dom, mon, dow].every(okField)) return { ok: false, text: 'unrecognized field — use numbers, ranges (1-5), lists (1,3), steps (*/n), or *' }

  // time phrase
  const two = (x: string) => x.padStart(2, '0')
  let time: string
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) time = `at ${two(hour)}:${two(min)}`
  else if (/^\d+$/.test(min) && hour === '*') time = `every hour at :${two(min)}`
  else if (min.startsWith('*/') && hour === '*') time = `every ${min.slice(2)} minutes`
  else if (/^\d+$/.test(min) && hour.startsWith('*/')) time = `every ${hour.slice(2)} hours at :${two(min)}`
  else if (min === '*' && hour === '*') time = 'every minute'
  else time = `at minute ${min} of hour ${hour}`

  // day phrase (crontab rule: both restricted = either matches)
  let day = ''
  if (dom !== '*' && dow !== '*') day = `on day ${fieldWords(dom)} of the month or on ${fieldWords(dow, DAY_NAMES)}`
  else if (dow !== '*') day = `on ${fieldWords(dow, DAY_NAMES)}`
  else if (dom !== '*') day = `on day ${fieldWords(dom)} of the month`

  const month = mon === '*' ? '' : `in month ${fieldWords(mon)}`
  return { ok: true, text: ['Runs', time, day, month].filter(Boolean).join(' ') }
}

/** A human-friendly schedule the simple editor collects; compiles to cron. */
export interface SimpleSchedule {
  freq: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  /** every N minutes (freq=minutes) */
  every: number
  /** HH:MM — the minute is used alone for hourly */
  time: string
  /** 0–6, Sunday=0 (freq=weekly) */
  dow: number
  /** 1–31 (freq=monthly) */
  dom: number
}

/** Compile the simple editor's schedule to a 5-field cron expression. */
export function buildCron(sp: SimpleSchedule): string {
  const [h, m] = sp.time.split(':').map(x => parseInt(x, 10))
  const hour = Number.isFinite(h) ? h : 9
  const min = Number.isFinite(m) ? m : 0
  switch (sp.freq) {
    case 'minutes': return `*/${Math.max(1, Math.min(59, Math.round(sp.every) || 1))} * * * *`
    case 'hourly': return `${min} * * * *`
    case 'daily': return `${min} ${hour} * * *`
    case 'weekly': return `${min} ${hour} * * ${Math.max(0, Math.min(6, sp.dow))}`
    case 'monthly': return `${min} ${hour} ${Math.max(1, Math.min(31, sp.dom))} * *`
  }
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
