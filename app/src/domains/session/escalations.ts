// Pure helpers over escalation cards (the `escalate` messages raised when a
// session needs input). The approvals inbox — the Needs-you group in the Runs
// rail — answers these without opening the session, so it needs the latest
// unresolved card per session, options included.
import type { Escalation, Message } from '../../core/types'

/** The latest unresolved escalation for a session, if any. */
export function pendingEscalation(messages: Message[], agentId: string): Escalation | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'escalate' && m.escFor === agentId && m.esc && !m.esc.resolved) return m.esc
  }
  return undefined
}
