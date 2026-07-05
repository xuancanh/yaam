// Discriminated session views over the shared Agent record. `Agent` carries both
// PTY-session and chat-session fields with everything optional, so callers keep
// branching on `kind` and assuming field presence. These guards narrow to the
// concrete shape and assert the fields each kind is guaranteed at creation —
// PtySession always has a launch `cmd`; ChatSession always has a `chatLog` array
// — so downstream code can drop the defensive optional-chaining. A first,
// non-breaking step toward the fuller domain-record split.
import type { Agent, ChatMsg } from '../../core/types'

/** A PTY-backed terminal session (external CLI over a native PTY). */
export type PtySession = Agent & { kind: 'real'; cmd: string }

/** An in-app LLM chat session (Claude-Desktop-style). */
export type ChatSession = Agent & { kind: 'chat'; chatLog: ChatMsg[] }

/** True for a chat session; narrows so `chatLog` is a present array. */
export function isChatSession(a: Agent): a is ChatSession {
  return a.kind === 'chat' && Array.isArray(a.chatLog)
}

/** True for a launched PTY session; narrows so `cmd` is present. */
export function isPtySession(a: Agent): a is PtySession {
  return a.kind === 'real' && typeof a.cmd === 'string'
}
