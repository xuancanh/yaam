// Pure extraction of a run's token usage from the structured transcript ring.
// Claude transcripts carry per-assistant-message usage objects (summed here);
// Codex rollouts stream cumulative token_count events (the last one wins).
// This is the typed ground truth the watcher gets at exit instead of prose,
// and the seed for the cost-analytics product-track item.

export interface RunUsage {
  inputTokens: number
  outputTokens: number
  /** count of assistant messages (claude); absent when the CLI only reports totals */
  assistantTurns?: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const rec = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' ? v as Record<string, unknown> : undefined)

/** Sum/select usage from parsed transcript events; undefined when none carry it. */
export function usageFromTranscript(events: readonly Record<string, unknown>[]): RunUsage | undefined {
  let inTok = 0
  let outTok = 0
  let turns = 0
  let codexLast: { inTok: number; outTok: number } | undefined
  for (const ev of events) {
    if (ev.type === 'assistant') {
      const usage = rec(rec(ev.message)?.usage)
      if (usage) {
        inTok += num(usage.input_tokens)
        outTok += num(usage.output_tokens)
        turns++
      }
    } else if (ev.type === 'event_msg') {
      const payload = rec(ev.payload)
      if (payload?.type !== 'token_count') continue
      // cumulative totals: prefer the nested total_token_usage, fall back to
      // a flat usage object on the payload
      const info = rec(payload.info)
      const totals = rec(info?.total_token_usage) ?? rec(payload.usage) ?? info
      if (totals && (totals.input_tokens !== undefined || totals.output_tokens !== undefined)) {
        codexLast = { inTok: num(totals.input_tokens), outTok: num(totals.output_tokens) }
      }
    }
  }
  if (codexLast) return { inputTokens: codexLast.inTok, outputTokens: codexLast.outTok }
  if (turns > 0) return { inputTokens: inTok, outputTokens: outTok, assistantTurns: turns }
  return undefined
}

/** Compact human form: "12.3k in / 4.1k out". */
export function formatUsage(u: RunUsage): string {
  const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `${k(u.inputTokens)} in / ${k(u.outputTokens)} out${u.assistantTurns ? ` · ${u.assistantTurns} turns` : ''}`
}
