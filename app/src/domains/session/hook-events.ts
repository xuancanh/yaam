// Runtime bridge from forwarded CLI hook events (native `agent-hook`) to
// session state. Strictly additive next to the regex scanner: hook signals
// raise/clear flags faster and more reliably for sessions that have hooks
// wired (local Claude launches), while everything downstream — escalation
// cards, watcher notes, notifications — keeps flowing through the same
// attention actions the scanner uses.
import type { AppState } from '../../core/types'
import { dispatch } from '../../core/store'
import { onAgentHook } from '../../core/native'
import type { AgentHookEvent } from '../../core/native'
import { hookSignal } from './hook-signals'
import { isHookNeedsFlag, markHookNeedsFlag } from './needs-provenance'
import { markStructuredSignal } from './signal-sources'

export interface SignalDeps {
  setNeedsInput: (id: string, question: string) => void
  clearNeeds: (id: string) => void
}

export interface HookEventsDeps extends SignalDeps {
  stateRef: { current: AppState }
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: AgentHookEvent) => void) => () => void
  /** the CLI switched conversations in-process (/clear, /resume picker):
   *  re-point anything keyed by the old id, e.g. the transcript tail */
  onCliSessionChange?: (agentId: string, sessionId: string, cwd: string, fresh: boolean) => void
}

const setResponding = (id: string, on: boolean) =>
  dispatch(s => ({
    ...s,
    agents: s.agents.map(a => (a.id === id && !!a.responding !== on ? { ...a, responding: on } : a)),
  }))

/** Apply one structured signal to a session — shared by every structured
 *  source (Claude hooks, the OpenCode event bus). */
export function applySessionSignal(
  deps: SignalDeps,
  agent: { id: string; status: string },
  sig: NonNullable<ReturnType<typeof hookSignal>>,
): void {
  switch (sig.kind) {
    case 'turn-start':
      setResponding(agent.id, true)
      break
    case 'activity':
      // a tool running means any hook-raised permission flag was answered in
      // the terminal; scanner/LLM flags are cleared by their own owners
      if (agent.status === 'needs' && isHookNeedsFlag(agent.id)) deps.clearNeeds(agent.id)
      setResponding(agent.id, true)
      break
    case 'needs':
      if (agent.status !== 'needs') {
        markHookNeedsFlag(agent.id)
        deps.setNeedsInput(agent.id, sig.question)
      }
      break
    case 'turn-end':
      setResponding(agent.id, false)
      break
    case 'session-end':
      // the process reaper owns exits; nothing to do here
      break
  }
}

/** Apply one forwarded hook event to session state (exported for tests). */
export function applyHookEvent(deps: HookEventsDeps, e: AgentHookEvent): void {
  const s = deps.stateRef.current
  const sid = typeof e.payload.session_id === 'string' ? e.payload.session_id : undefined
  const cwd = typeof e.payload.cwd === 'string' ? e.payload.cwd : undefined
  // resolution order: our own session id from the hook URL, then the CLI's
  // session id, then — for file-hook CLIs whose events have neither (a kiro
  // session the user launched outside YAAM) — a unique live session in the
  // event's working folder
  const byCwd = () => {
    if (!cwd) return undefined
    const live = s.agents.filter(a => !a.archived && (a.status === 'running' || a.status === 'needs') && a.cwd === cwd)
    return live.length === 1 ? live[0] : undefined
  }
  const agent = (e.agent ? s.agents.find(a => a.id === e.agent) : undefined)
    ?? (sid ? s.agents.find(a => a.cliSessionId === sid && !a.archived) : undefined)
    ?? byCwd()
  if (!agent || agent.archived) return
  // Keep the resume id in step with the CLI. Only trusted when the event names
  // OUR session (agent param in the hook URL): Claude's /clear and in-app
  // /resume swap the conversation under a new id while the process lives on,
  // and resuming the stale id later would reopen the wrong conversation (or
  // one the CLI's retention sweep has already deleted).
  if (e.agent && agent.id === e.agent && sid && sid !== agent.cliSessionId) {
    const prev = agent.cliSessionId
    dispatch(st => ({
      ...st,
      agents: st.agents.map(a => a.id === agent.id && a.cliSessionId !== sid
        ? {
            ...a,
            cliSessionId: sid,
            log: a.log.concat([{ t: 'sys' as const, x: prev ? `CLI switched conversation · resume id now ${sid}` : `captured CLI session · ${sid}` }]),
          }
        : a),
    }))
    // /clear starts an empty transcript (stream it whole); a switch to an
    // existing conversation only streams what is appended from now on
    deps.onCliSessionChange?.(agent.id, sid, cwd ?? agent.cwd ?? '', e.payload.source === 'clear')
  }
  // any hook event is proof the CLI feeds us structured signals — the regex
  // scanner stands down for this session while events stay fresh
  markStructuredSignal(agent.id, 'hooks')
  const sig = hookSignal(e.payload)
  if (!sig) return
  applySessionSignal(deps, agent, sig)
}

/** Subscribe to hook events; returns an unsubscribe function. */
export function attachHookEvents(deps: HookEventsDeps): () => void {
  const subscribe = deps.subscribe ?? onAgentHook
  return subscribe(e => applyHookEvent(deps, e))
}
