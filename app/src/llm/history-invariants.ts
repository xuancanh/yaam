// Provider-conversation invariants, as checkable predicates. Providers reject
// a request when a tool_use lacks its tool_result (or vice versa) or when the
// conversation opens with tool debris — and because retained histories are
// reused turn after turn, one violation silently mutes that assistant forever.
// Runtimes enforce these with sanitizeToolHistory/capToolHistory (tool loops)
// and sanitizeChatHistory/capChatHistory (chat); tests assert them with these
// helpers instead of re-deriving the rules per test file.
import type { ApiContentBlock, ApiMessage } from './client'

/** Does this message carry tool blocks (tool_use or tool_result)? */
export function carriesToolBlocks(m: ApiMessage): boolean {
  return Array.isArray(m.content)
    && (m.content as ApiContentBlock[]).some(b => b.type === 'tool_use' || b.type === 'tool_result')
}

/** Every tool_use id has a matching tool_result and vice versa. */
export function toolPairsIntact(history: ApiMessage[]): boolean {
  const uses = new Set<string>()
  const results = new Set<string>()
  for (const m of history) {
    if (!Array.isArray(m.content)) continue
    // tool_result blocks carry tool_use_id, which the shared block type omits
    for (const b of m.content as Array<ApiContentBlock & { tool_use_id?: string }>) {
      if (b.type === 'tool_use' && b.id) uses.add(b.id)
      if (b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id)
    }
  }
  return [...uses].every(id => results.has(id)) && [...results].every(id => uses.has(id))
}

/** The conversation opens with a real user message, not tool debris.
 *  Strict (default): the opener must be a plain string — the tool-loop rule.
 *  `allowArrays`: block-array openers are fine as long as they carry no tool
 *  blocks — the chat rule (conversations legitimately open with attachments). */
export function opensClean(history: ApiMessage[], opts: { allowArrays?: boolean } = {}): boolean {
  if (history.length === 0) return true
  const head = history[0]
  if (head.role !== 'user') return false
  if (typeof head.content === 'string') return true
  return Boolean(opts.allowArrays) && !carriesToolBlocks(head)
}
