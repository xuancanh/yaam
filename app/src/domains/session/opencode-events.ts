// Runtime bridge from the OpenCode server event bus (native `opencode-event`)
// to session state. OpenCode's TUI is a client of its own local HTTP server;
// YAAM pins that server's port at launch and streams its SSE bus, which makes
// these signals authoritative: permission.asked/replied and session.idle come
// from the server, not from screen heuristics. The first session-scoped event
// also captures the CLI session id (its SQLite store made file detection
// blind), so resume works via `opencode --session {id}`.
import type { AppState } from '../../core/types'
import { dispatch } from '../../core/store'
import { onOpencodeEvent } from '../../core/native'
import type { OpencodeEvent } from '../../core/native'
import type { HookSignal } from './hook-signals'
import { applySessionSignal } from './hook-events'
import type { SignalDeps } from './hook-events'
import { markStructuredSignal } from './signal-sources'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

const props = (payload: Record<string, unknown>): Record<string, unknown> =>
  (payload.properties && typeof payload.properties === 'object' ? payload.properties as Record<string, unknown> : {})

/** The server session an event belongs to, wherever the bus carries it. */
export function opencodeSessionId(payload: Record<string, unknown>): string | undefined {
  const p = props(payload)
  const info = p.info && typeof p.info === 'object' ? p.info as Record<string, unknown> : {}
  return str(p.sessionID) ?? str(info.sessionID) ?? str(info.id)
}

/** Map one server-bus event to a session signal; null = no signal we act on. */
export function opencodeSignal(payload: Record<string, unknown>): HookSignal | null {
  const type = str(payload.type) ?? ''
  const p = props(payload)
  switch (type) {
    case 'permission.asked': {
      const what = str(p.title)
        ?? str((p.permission as Record<string, unknown> | undefined)?.title)
        ?? str(p.type)
      return { kind: 'needs', question: `Permission needed${what ? ` · ${what.slice(0, 100)}` : ''}` }
    }
    case 'permission.replied':
      // answered (in the TUI or via the API) — same clearing semantics as a
      // tool starting to run
      return { kind: 'activity' }
    case 'session.idle':
      return { kind: 'turn-end' }
    case 'session.error':
      return { kind: 'turn-end' }
    case 'session.status':
    case 'message.updated':
    case 'message.part.updated':
      return { kind: 'activity' }
    default:
      return null
  }
}

export interface OpencodeEventsDeps extends SignalDeps {
  stateRef: { current: AppState }
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: OpencodeEvent) => void) => () => void
}

/** Apply one forwarded server event to session state (exported for tests). */
export function applyOpencodeEvent(deps: OpencodeEventsDeps, e: OpencodeEvent): void {
  const agent = deps.stateRef.current.agents.find(a => a.id === e.agent)
  if (!agent || agent.archived) return
  // a connected server bus is authoritative — the regex scanner stands down
  markStructuredSignal(agent.id, 'opencode-bus')
  const sid = opencodeSessionId(e.payload)
  if (sid && !agent.cliSessionId) {
    // first session-scoped event names the TUI's conversation — capture it
    // for resume (`opencode --session {id}`)
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agent.id && !a.cliSessionId
        ? { ...a, cliSessionId: sid, log: a.log.concat([{ t: 'sys', x: `captured OpenCode session · ${sid}` }]) }
        : a),
    }))
  } else if (sid && agent.cliSessionId && sid !== agent.cliSessionId) {
    // another conversation on the same server (subagent, second tab) — not ours
    return
  }
  const sig = opencodeSignal(e.payload)
  if (sig) applySessionSignal(deps, agent, sig)
}

/** Subscribe to server events; returns an unsubscribe function. */
export function attachOpencodeEvents(deps: OpencodeEventsDeps): () => void {
  const subscribe = deps.subscribe ?? onOpencodeEvent
  return subscribe(e => applyOpencodeEvent(deps, e))
}
