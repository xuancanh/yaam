import type { LogLine } from './types'

/** Terminal output is only a proxy: YAAM cannot see provider-side billing usage. */
export const OUTPUT_CHARS_PER_TOKEN = 4
export const ESTIMATED_OUTPUT_COST_PER_KTOK = 0.04

export interface UsageEstimate {
  /** Estimated output tokens, in thousands. */
  used: number
  /** Estimated output cost in USD. */
  cost: number
}

/** Convert a printable-character count into YAAM's token and cost estimates. */
function estimateOutputChars(chars: number): UsageEstimate {
  const used = chars / (OUTPUT_CHARS_PER_TOKEN * 1000)
  return { used, cost: used * ESTIMATED_OUTPUT_COST_PER_KTOK }
}

/** Estimate provider-visible output usage for one terminal text fragment. */
export function estimateOutputUsage(text: string): UsageEstimate {
  return estimateOutputChars(text.length)
}

/** Rebuild usage totals from the retained output entries in a session log. */
export function estimateLogUsage(log: LogLine[]): UsageEstimate {
  let chars = 0
  for (const line of log) {
    if (line.t === 'out') chars += line.x.length
  }
  return estimateOutputChars(chars)
}

/** Format a thousand-token value for compact display without implying precision. */
export function formatEstimatedTokens(kTokens: number): string {
  const tokens = Math.max(0, kTokens) * 1000
  if (tokens < 1000) return `${Math.round(tokens)} tok`
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(2)}k tok`
  return `${(tokens / 1000).toFixed(1)}k tok`
}
