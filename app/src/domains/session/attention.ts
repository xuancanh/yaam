// Session attention/output helpers: the screen tail for LLM context, flagging a
// settled prompt as "needs input" (with the escalation card), merging monitor-
// authored status onto a card, and appending the bounded output tail (+ usage
// estimate). Extracted from the provider; operates on the store + injected
// activity callbacks. (clearNeeds stays in the provider — it needs the settle
// watcher's clearFlagged, which is created after these.)
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AddonHookName, AppState, EscOption, EventType, NotifKind } from '../../core/types'
import { dispatch } from '../../core/store'
import { mkId } from '../../shared/id'
import { isAltScreen, readScreen } from '../../core/terminals'
import { estimateLogUsage, estimateOutputUsage } from '../../core/usage'

export interface SessionAttentionCtx {
  stateRef: MutableRefObject<AppState>
  widOf: (s: AppState, agentId: string | null) => string
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  fireAddonHook: (hook: AddonHookName, event: Record<string, unknown>) => void
}

export interface SessionAttention {
  sessionScreenTail: (id: string) => string
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  appendTail: (id: string, line: string) => void
}

export function useSessionAttention(ctx: SessionAttentionCtx): SessionAttention {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSessionAttention(ctx), [ctx.stateRef, ctx.widOf, ctx.logEvent, ctx.notify, ctx.fireAddonHook])
}

/** Plain (non-React) factory for the attention/output helpers. */
export function createSessionAttention(ctx: SessionAttentionCtx): SessionAttention {
  const { stateRef, widOf, logEvent, notify, fireAddonHook } = ctx

  // Output lines are batched into ONE store dispatch per flush window. A busy
  // CLI emits dozens of lines a second, and dispatching per line re-rendered
  // every store subscriber at PTY speed — felt as typing lag in the terminal.
  const pendingTail = new Map<string, string[]>()
  let tailTimer: ReturnType<typeof setTimeout> | null = null
  const flushTail = () => {
    tailTimer = null
    const batch = new Map(pendingTail)
    pendingTail.clear()
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => {
        const lines = batch.get(a.id)
        if (!lines?.length) return a
        // Old releases added a fixed 10 tokens for every line. Rebase those
        // counters on the retained output tail before using the character estimate.
        const base = a.usageVersion === 1 ? a : estimateLogUsage(a.log)
        let used = base.used
        let cost = base.cost
        for (const line of lines) {
          const delta = estimateOutputUsage(line)
          used += delta.used
          cost += delta.cost
        }
        const log = a.log.concat(lines.map(x => ({ t: 'out' as const, x })))
        if (log.length > 200) log.splice(0, log.length - 200)
        return { ...a, log, used, cost, usageVersion: 1 }
      }),
    }))
  }

  return {
    // Prefer the rendered screen for TUI context and fall back to retained log lines.
    sessionScreenTail: (id: string): string => {
      const lines = isAltScreen(id)
        ? readScreen(id)
        : (stateRef.current.agents.find(a => a.id === id)?.log ?? []).map(l => l.x)
      return lines.filter(Boolean).slice(-10).join('\n') || '(no output)'
    },

    // Record a settled prompt, deduplicate it, and surface user-action state.
    setNeedsInput: (id, question, options, cursorNum) => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (!agent || agent.status !== 'running') return
      dispatch(s => {
        const msg = {
          id: mkId('m'), role: 'master' as const, kind: 'escalate' as const, escFor: id,
          esc: {
            name: agent.name, color: agent.color, repo: agent.repo, reason: question,
            resolved: false, decision: null,
            options: options?.length ? options : undefined,
            cursorNum: cursorNum ?? 1,
          },
        }
        const withStatus = {
          ...s,
          agents: s.agents.map(a => a.id === id ? { ...a, status: 'needs' as const, escReason: question, attention: true } : a),
        }
        const wid = widOf(s, id)
        if (wid === s.activeWorkspace) return { ...withStatus, messages: s.messages.concat([msg]) }
        const d = s.workspaceData[wid]
        if (!d) return withStatus
        return { ...withStatus, workspaceData: { ...s.workspaceData, [wid]: { ...d, messages: d.messages.concat([msg]) } } }
      })
      logEvent('escalate', id, `${agent.name} is asking for input: ${question.slice(0, 64)}`)
      notify('escalate', `${agent.name} needs your input`, question.slice(0, 80), id)
      fireAddonHook('onNeedsInput', { sessionId: id, name: agent.name, question })
    },

    // Merge monitor-authored status fields into one session card.
    applyAgentStatus: (sid, task, summary, actionNeeded) => {
      const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      dispatch(s2 => ({
        ...s2,
        agents: s2.agents.map(a => a.id === sid
          ? {
              ...a,
              task: task !== undefined ? (task || undefined) : a.task,
              summary: summary !== undefined ? (summary || undefined) : a.summary,
              actionNeeded: actionNeeded !== undefined ? (actionNeeded || undefined) : a.actionNeeded,
              attention: a.attention || Boolean(actionNeeded),
              summaryAt: at,
            }
          : a),
      }))
    },

    // Retain a bounded plain-text output tail and update character usage
    // estimates — batched (see flushTail) so output volume never dictates
    // render frequency.
    appendTail: (id, line) => {
      const q = pendingTail.get(id)
      if (q) {
        q.push(line)
        if (q.length > 400) q.splice(0, q.length - 200) // runaway output — the log keeps 200 anyway
      } else {
        pendingTail.set(id, [line])
      }
      if (!tailTimer) tailTimer = setTimeout(flushTail, 100)
    },
  }
}
