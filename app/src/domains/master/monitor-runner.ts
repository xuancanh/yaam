// Per-session monitor LLM loop. Each session has a private monitor that digests
// its terminal output locally and only escalates to Master via report_to_master.
// Extracted from the provider: it operates on the stable refs/callbacks passed
// in `ctx`, so the provider keeps a thin delegating callback.
import type { MutableRefObject } from 'react'
import type { AppState, EscOption, EventType, NotifKind } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import { runMonitorTurn } from '../../monitor'
import type { MonitorExec } from '../../monitor'
import { mkId } from '../../shared/id'
import { formatHits, memoryDigest, searchMemory, wsMemory } from './assistant-memory'
import { calibrationNote, recordDecision } from './harness-stats'
import { isAltScreen, readScreen } from '../../core/terminals'
import { extractOptions } from '../session/prompt-detection'
import type { AbortRegistry } from '../../core/abort-registry'
import { isAbortError } from '../../core/abort-registry'

export interface MonitorCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  histories: Map<string, ApiMessage[]>
  busy: Set<string>
  queue: Map<string, string[]>
  /** per-session cancellation — aborted when the session is disposed */
  aborts: AbortRegistry
  applyAgentStatus: (sid: string, task?: string, summary?: string, nextAction?: string, actionNeeded?: string) => void
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  masterEvent: (note: string, agentId?: string) => void
}

/** Serialize private monitor turns per session and cap their retained history. */
export async function runMonitorLoop(ctx: MonitorCtx, id: string, note: string) {
  const st = ctx.stateRef.current.settings
  if (!(st.masterEnabled && hasCreds(st) && st.followMode)) return
  if (ctx.busy.has(id)) {
    ctx.queue.set(id, [...(ctx.queue.get(id) ?? []), note].slice(-8))
    return
  }
  ctx.busy.add(id)
  const runSignal = ctx.aborts.signal(id)
  try {
    let pending: string | undefined = note
    while (pending !== undefined) {
      const current = pending
      pending = undefined
      const agent = ctx.stateRef.current.agents.find(a => a.id === id)
      if (!agent) break
      let history = ctx.histories.get(id)
      if (!history) {
        history = []
        ctx.histories.set(id, history)
      }
      const exec: MonitorExec = {
        updateStatus: (task, summary, nextAction, actionNeeded) => {
          ctx.applyAgentStatus(id, task, summary, nextAction, actionNeeded)
          return 'status updated'
        },
        flagNeedsInput: question => {
          const screen = isAltScreen(id) ? readScreen(id) : (ctx.stateRef.current.agents.find(a => a.id === id)?.log ?? []).slice(-14).map(l => l.x)
          const { options, cursorNum } = extractOptions(screen)
          ctx.setNeedsInput(id, question || 'waiting for input', options, cursorNum)
          // implicit-feedback eval: approve/deny/answer resolves this decision
          ctx.dispatch(s2 => ({
            ...s2,
            harnessLog: recordDecision(s2.harnessLog, { role: 'monitor', kind: 'needs_input', agentId: id, text: (question || 'waiting for input').slice(0, 140) }),
          }))
          return 'flagged as needing input'
        },
        suggestActions: list => {
          const suggestions = list.map(x => ({ id: mkId('sg'), label: x.label, send: x.send }))
          ctx.dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => (a.id === id ? { ...a, suggestions } : a)),
            harnessLog: recordDecision(s2.harnessLog, {
              role: 'monitor', kind: 'suggestion', agentId: id,
              text: suggestions.map(x => x.label).join(' · ').slice(0, 160),
            }),
          }))
          return `${suggestions.length} suggestion(s) shown to the user`
        },
        memoryLookup: query => formatHits(searchMemory(wsMemory(ctx.stateRef.current, agent.workspaceId), query)),
        reportToMaster: (digest, importance) => {
          const a = ctx.stateRef.current.agents.find(x => x.id === id)
          ctx.dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(x => (x.id === id ? { ...x, attention: true } : x)),
          }))
          ctx.logEvent(importance === 'info' ? 'done' : 'escalate', id, `Monitor: ${digest.slice(0, 96)}`)
          if (importance === 'critical' && a) ctx.notify('escalate', `${a.name} needs attention`, digest.slice(0, 90), id)
          ctx.masterEvent(
            `[monitor report · ${importance}] session "${a?.name ?? id}" (${id}): ${digest}\n\n` +
            'This came from the session\'s dedicated monitor. Relay it to the user in 1-2 sentences ending with "Next action:", and act with your tools if needed.',
            id,
          )
          return 'reported to Master'
        },
      }
      try {
        const cur = ctx.stateRef.current
        await runMonitorTurn(buildCfg(st, st.monitorModel || undefined), agent, current, history, exec, runSignal, {
          memoryDigest: memoryDigest(wsMemory(cur, agent.workspaceId), ['approvals', 'preferences', 'patterns']),
          calibration: calibrationNote(cur.harnessLog, 'monitor'),
          custom: cur.settings.assistantPrompts?.monitor,
        })
      } catch (e) {
        // the session was disposed mid-turn — stop quietly, don't report an error
        if (isAbortError(e) || runSignal.aborted) { pending = undefined; break }
        ctx.logEvent('escalate', id, `Monitor error: ${e instanceof Error ? e.message : String(e)}`)
      }
      const queued = ctx.queue.get(id)
      pending = queued?.length ? queued.join('\n\n') : undefined
      ctx.queue.delete(id)
    }
  } finally {
    const released = ctx.aborts.clear(id, runSignal)
    if (released || !ctx.aborts.has(id)) ctx.busy.delete(id)
  }
}
