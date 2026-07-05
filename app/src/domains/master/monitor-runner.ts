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
import { isAltScreen, readScreen } from '../../core/terminals'
import { extractOptions } from '../../core/state-lib'

export interface MonitorCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  histories: MutableRefObject<Map<string, ApiMessage[]>>
  busy: MutableRefObject<Set<string>>
  queue: MutableRefObject<Map<string, string>>
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  masterEvent: (note: string, agentId?: string) => void
}

/** Serialize private monitor turns per session and cap their retained history. */
export async function runMonitorLoop(ctx: MonitorCtx, id: string, note: string) {
  const st = ctx.stateRef.current.settings
  if (!(st.masterEnabled && hasCreds(st) && st.followMode)) return
  if (ctx.busy.current.has(id)) {
    ctx.queue.current.set(id, note)
    return
  }
  ctx.busy.current.add(id)
  try {
    let pending: string | undefined = note
    while (pending !== undefined) {
      const current = pending
      pending = undefined
      const agent = ctx.stateRef.current.agents.find(a => a.id === id)
      if (!agent) break
      let history = ctx.histories.current.get(id)
      if (!history) {
        history = []
        ctx.histories.current.set(id, history)
      }
      const exec: MonitorExec = {
        updateStatus: (task, summary, actionNeeded) => {
          ctx.applyAgentStatus(id, task, summary, actionNeeded)
          return 'status updated'
        },
        flagNeedsInput: question => {
          const screen = isAltScreen(id) ? readScreen(id) : (ctx.stateRef.current.agents.find(a => a.id === id)?.log ?? []).slice(-14).map(l => l.x)
          const { options, cursorNum } = extractOptions(screen)
          ctx.setNeedsInput(id, question || 'waiting for input', options, cursorNum)
          return 'flagged as needing input'
        },
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
        await runMonitorTurn(buildCfg(st, st.monitorModel || undefined), agent, current, history, exec)
      } catch (e) {
        ctx.logEvent('escalate', id, `Monitor error: ${e instanceof Error ? e.message : String(e)}`)
      }
      pending = ctx.queue.current.get(id)
      ctx.queue.current.delete(id)
    }
  } finally {
    ctx.busy.current.delete(id)
  }
}
