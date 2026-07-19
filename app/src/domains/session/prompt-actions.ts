// Answering a session's terminal prompt from the UI: pick a numbered option,
// approve (Enter), or deny (Escape). These write control sequences to the PTY and
// resolve the escalation card. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType } from '../../core/types'
import { dispatch } from '../../core/store'
import { withMemoryAppend } from '../master/assistant-memory'
import { resolveDecision } from '../master/harness-stats'
import { createSessionActivity, withActivityTargets } from '../activity/history'
import { sendLineToSession } from './command'
import { realSessionProcessPort } from './ports'
import type { SessionProcessPort } from './ports'

export interface PromptActionsCtx {
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  armResponseWatch: (id: string) => void
  clearFlagged: (id: string) => void
  /** native PTY capability; defaults to the real IPC-backed port */
  port?: SessionProcessPort
}

export interface SessionPromptActions {
  answerPrompt: (aid: string, num: number) => void
  approve: (aid: string) => void
  deny: (aid: string) => void
  /** run one of the monitor's suggested actions: send it to the session,
   *  record the acceptance, and learn the pattern */
  runSuggestion: (aid: string, suggestionId: string) => void
  /** clear a session's suggestions and record the dismissal */
  dismissSuggestions: (aid: string) => void
}

export function useSessionPromptActions(ctx: PromptActionsCtx): SessionPromptActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSessionPromptActions(ctx), [ctx.stateRef, ctx.flash, ctx.logEvent, ctx.armResponseWatch, ctx.clearFlagged, ctx.port])
}

/** The prompt-answer actions as a plain factory (no React), for unit testing. */
export function createSessionPromptActions(ctx: PromptActionsCtx): SessionPromptActions {
  const { stateRef, flash, logEvent, armResponseWatch, clearFlagged } = ctx
  const port = ctx.port ?? realSessionProcessPort
  return {
    answerPrompt: (aid, num) => {
      const st = stateRef.current
      const agent = st.agents.find(a => a.id === aid)
      const msg = [...st.messages].reverse().find(m => m.kind === 'escalate' && m.escFor === aid && m.esc && !m.esc.resolved)
      const esc = msg?.esc
      if (!agent || !esc?.options?.length) return
      const target = esc.options.find(o => o.num === num)
      if (!target) return
      const delta = num - (esc.cursorNum ?? 1)
      const moves = delta > 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)
      if (moves) port.writeSession(aid, moves).catch(() => {})
      window.setTimeout(() => { port.writeSession(aid, '\r').catch(() => {}) }, 200)
      clearFlagged(aid)
      const event = createSessionActivity(st, aid, {
        category: 'decision', actor: 'user', kind: 'choose', text: `Chose “${target.label}”`, detail: esc.reason || undefined,
      })
      dispatch(s => withMemoryAppend(withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'you' as const, x: `chose ${num}. ${target.label}` }]) }
          : a),
        messages: s.messages.map(m => m === msg && m.esc
          ? { ...m, esc: { ...m.esc, resolved: true, decision: 'approved' as const, choice: `${num}. ${target.label}` } }
          : m),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'needs_input', agentId: aid }, 'accepted', `${num}. ${target.label}`),
      }, event, { sessionId: aid, taskId: event.taskId }), 'approvals', `prompt "${(esc.reason ?? '').slice(0, 90)}" in ${agent.name} → chose "${target.label}"`))
      flash(`Chose “${target.label}”`)
      logEvent('done', aid, `Answered prompt · ${num}. ${target.label}`)
      armResponseWatch(aid)
    },

    approve: aid => {
      const agent = stateRef.current.agents.find(a => a.id === aid)
      // answer the prompt: Enter accepts the default / highlighted option
      if (agent?.kind === 'real') port.writeSession(aid, '\r').catch(() => {})
      const reason = (agent?.escReason ?? '').slice(0, 90)
      const event = createSessionActivity(stateRef.current, aid, {
        category: 'decision', actor: 'user', kind: 'approve', text: 'Approved prompt', detail: reason || undefined,
      })
      dispatch(s => withMemoryAppend(withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'sys' as const, x: 'approved by you' }]) }
          : a),
        messages: s.messages.map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'approved' as const } } : m)),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'needs_input', agentId: aid }, 'accepted', 'approved'),
      }, event, { sessionId: aid, taskId: event.taskId }), 'approvals', reason ? `prompt "${reason}" in ${agent?.name ?? aid} → approved` : ''))
      flash(`Approved — ${agent?.name || 'agent'} resumed`)
      logEvent('done', aid, 'Approved · prompt accepted')
    },

    deny: aid => {
      const agent = stateRef.current.agents.find(a => a.id === aid)
      // Escape cancels the prompt
      if (agent?.kind === 'real') port.writeSession(aid, '\x1b').catch(() => {})
      const reason = (agent?.escReason ?? '').slice(0, 90)
      const event = createSessionActivity(stateRef.current, aid, {
        category: 'decision', actor: 'user', kind: 'deny', text: 'Denied prompt', detail: reason || undefined,
      })
      dispatch(s => withMemoryAppend(withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'sys' as const, x: 'denied · prompt cancelled' }]) }
          : a),
        messages: s.messages.map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'denied' as const } } : m)),
        // the flag itself was right (the user engaged) — the answer was "no"
        harnessLog: resolveDecision(s.harnessLog, { kind: 'needs_input', agentId: aid }, 'accepted', 'denied'),
      }, event, { sessionId: aid, taskId: event.taskId }), 'approvals', reason ? `prompt "${reason}" in ${agent?.name ?? aid} → denied` : ''))
      flash(`Denied — prompt cancelled`)
      logEvent('escalate', aid, 'Denied · prompt cancelled')
    },

    runSuggestion: (aid, suggestionId) => {
      const agent = stateRef.current.agents.find(a => a.id === aid)
      const sug = agent?.suggestions?.find(x => x.id === suggestionId)
      if (!agent || !sug) return
      sendLineToSession(aid, sug.send)
      armResponseWatch(aid)
      const event = createSessionActivity(stateRef.current, aid, {
        category: 'decision', actor: 'user', kind: 'choose', text: `Ran suggestion · ${sug.label}`, detail: sug.send,
      })
      dispatch(s => withMemoryAppend(withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, suggestions: undefined, log: a.log.concat([{ t: 'you' as const, x: `ran suggestion · ${sug.label}` }]) }
          : a),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'suggestion', agentId: aid }, 'accepted', sug.label),
      }, event, { sessionId: aid, taskId: event.taskId }), 'patterns', `when "${(agent.summary || agent.task || agent.name).slice(0, 90)}" → user ran "${sug.label}" (${sug.send.slice(0, 80)})`))
      flash(`Sent “${sug.label}”`)
      logEvent('route', aid, `Ran suggestion · ${sug.label}`)
    },

    dismissSuggestions: aid => {
      const event = createSessionActivity(stateRef.current, aid, {
        category: 'decision', actor: 'user', kind: 'dismiss', text: 'Dismissed suggestions',
      })
      dispatch(s => withActivityTargets({
        ...s,
        agents: s.agents.map(a => (a.id === aid ? { ...a, suggestions: undefined } : a)),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'suggestion', agentId: aid }, 'dismissed'),
      }, event, { sessionId: aid, taskId: event.taskId }))
    },
  }
}
