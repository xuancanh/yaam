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

export interface SignalDeps {
  setNeedsInput: (id: string, question: string) => void
  clearNeeds: (id: string) => void
}

export interface HookEventsDeps extends SignalDeps {
  stateRef: { current: AppState }
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: AgentHookEvent) => void) => () => void
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
  // the hook URL carries our own session id; the CLI session id is the fallback
  const agent = (e.agent ? s.agents.find(a => a.id === e.agent) : undefined)
    ?? (sid ? s.agents.find(a => a.cliSessionId === sid && !a.archived) : undefined)
  if (!agent || agent.archived) return
  const sig = hookSignal(e.payload)
  if (!sig) return
  applySessionSignal(deps, agent, sig)
}

/** Subscribe to hook events; returns an unsubscribe function. */
export function attachHookEvents(deps: HookEventsDeps): () => void {
  const subscribe = deps.subscribe ?? onAgentHook
  return subscribe(e => applyHookEvent(deps, e))
}
