// Pure mapping from a CLI lifecycle-hook payload (Claude Code hook JSON) to a
// session signal. Structured counterpart of prompt-detection: where the regex
// scanner guesses from the rendered screen, these signals come from the CLI
// itself, so consumers may treat them as authoritative for the sessions that
// have hooks wired.

export type HookSignal =
  | { kind: 'turn-start' }
  | { kind: 'activity'; tool?: string }
  | { kind: 'needs'; question: string }
  | { kind: 'turn-end' }
  | { kind: 'session-end' }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const toolNameOf = (payload: Record<string, unknown>): string | undefined =>
  str(payload.tool_name) ?? str(payload.toolName)

/** One-line human description of a permission request. */
function permissionQuestion(payload: Record<string, unknown>): string {
  const tool = toolNameOf(payload) ?? 'a tool'
  const input = payload.tool_input as Record<string, unknown> | undefined
  const detail = str(input?.command) ?? str(input?.file_path) ?? str(input?.url)
  return `Permission needed · ${tool}${detail ? ` — ${detail.slice(0, 100)}` : ''}`
}

/** Map one hook payload to a session signal; null = event carries no signal
 *  we act on (unknown events, informational notifications). Field spellings
 *  cover both dialects: Claude Code (`hook_event_name`) and Kiro (`trigger`). */
export function hookSignal(payload: Record<string, unknown>): HookSignal | null {
  switch (str(payload.hook_event_name) ?? str(payload.trigger)) {
    case 'UserPromptSubmit':
      return { kind: 'turn-start' }
    case 'PreToolUse':
    case 'PostToolUse':
      return { kind: 'activity', tool: toolNameOf(payload) }
    case 'PermissionRequest':
      return { kind: 'needs', question: permissionQuestion(payload) }
    case 'Notification': {
      // only notifications that mean "waiting on you" raise the flag; the rest
      // (idle reminders, info) carry no signal
      const text = [str(payload.notification_type), str(payload.message), str(payload.title)]
        .filter(Boolean).join(' ')
      if (/permission|approval|waiting for.*input|needs your/i.test(text)) {
        return { kind: 'needs', question: str(payload.message) ?? 'Waiting for your input' }
      }
      return null
    }
    case 'Stop':
      return { kind: 'turn-end' }
    case 'SessionEnd':
      return { kind: 'session-end' }
    default:
      return null
  }
}
