// Runtime bridge for ACP sessions (native `acp-event`). The agent has no TUI:
// the session's terminal is a rendered feed of protocol updates (message and
// thought chunks, tool calls, plans), permissions arrive as structured
// requests answered from the escalation card, and turn boundaries come from
// prompt responses. Everything flows through the same attention actions and
// signal applier the other structured sources use.
import type { AppState } from '../../core/types'
import type { EscOption } from '../../core/types'
import { dispatch } from '../../core/store'
import { acpRespondPermission, onAcpEvent } from '../../core/native'
import type { AcpEvent } from '../../core/native'
import { getTerminal } from '../../core/terminals'
import { applySessionSignal } from './hook-events'
import type { SignalDeps } from './hook-events'
import { markHookNeedsFlag } from './needs-provenance'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

interface PendingPermission {
  requestId: unknown
  options: { num: number; optionId: string; label: string; kind: string }[]
}

const pendingPerms = new Map<string, PendingPermission>()
// per-session partial-line buffers: chunks stream mid-sentence, the terminal
// wants whole lines. Keyed message/thought so interleaving stays readable.
const lineBufs = new Map<string, string>()

/** Test/teardown helper. */
export function resetAcpRuntime(): void {
  pendingPerms.clear()
  lineBufs.clear()
}

const writeln = (aid: string, line: string) => {
  // rendering is best-effort: a session without a live terminal (headless
  // test env, disposed pane) still gets its signals applied
  try { getTerminal(aid).term.writeln(line) } catch { /* no terminal */ }
}

function pushChunk(aid: string, lane: 'm' | 't', text: string): void {
  const key = `${aid}:${lane}`
  const buf = (lineBufs.get(key) ?? '') + text
  const lines = buf.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) writeln(aid, lane === 't' ? `\x1b[90m${line}\x1b[0m` : line)
  lineBufs.set(key, rest)
}

function flushChunks(aid: string): void {
  for (const lane of ['m', 't'] as const) {
    const key = `${aid}:${lane}`
    const rest = lineBufs.get(key)
    if (rest) writeln(aid, lane === 't' ? `\x1b[90m${rest}\x1b[0m` : rest)
    lineBufs.delete(key)
  }
}

/** Deliver a prompt answer to an ACP session's pending permission request.
 *  Returns false when the session has none (the PTY key path applies). */
export function deliverAcpAnswer(aid: string, choice: number | 'approve' | 'deny'): boolean {
  const pending = pendingPerms.get(aid)
  if (!pending) return false
  const opt = choice === 'approve'
    ? pending.options.find(o => o.kind.startsWith('allow')) ?? pending.options[0]
    : choice === 'deny'
      ? pending.options.find(o => o.kind.startsWith('reject')) ?? pending.options[pending.options.length - 1]
      : pending.options.find(o => o.num === choice)
  if (!opt) return false
  pendingPerms.delete(aid)
  void acpRespondPermission(aid, pending.requestId, opt.optionId)
  writeln(aid, `\x1b[33m▸ permission · ${opt.label}\x1b[0m`)
  return true
}

export interface AcpEventsDeps extends SignalDeps {
  stateRef: { current: AppState }
  /** extended: permission cards carry the protocol's own options */
  setNeedsInput: (id: string, question: string, options?: EscOption[]) => void
  /** event subscription; defaults to the native bridge (injectable for tests) */
  subscribe?: (cb: (e: AcpEvent) => void) => () => void
}

/** Apply one forwarded protocol event (exported for tests). */
export function applyAcpEvent(deps: AcpEventsDeps, e: AcpEvent): void {
  const agent = deps.stateRef.current.agents.find(a => a.id === e.agent)
  if (!agent || agent.archived) return
  const aid = agent.id
  switch (e.kind) {
    case 'ready': {
      const sid = e.sessionId ?? ''
      if (sid && agent.cliSessionId !== sid) {
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === aid ? { ...a, cliSessionId: sid } : a),
        }))
      }
      writeln(aid, `\x1b[90m── acp session ready${sid ? ` · ${sid}` : ''} ──\x1b[0m`)
      break
    }
    case 'update': {
      const update = (e.params?.update ?? {}) as Record<string, unknown>
      const content = update.content as Record<string, unknown> | undefined
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          pushChunk(aid, 'm', str(content?.text) ?? '')
          applySessionSignal(deps, agent, { kind: 'activity' })
          break
        case 'agent_thought_chunk':
          pushChunk(aid, 't', str(content?.text) ?? '')
          applySessionSignal(deps, agent, { kind: 'activity' })
          break
        case 'tool_call': {
          flushChunks(aid)
          const kind = str(update.kind) ?? 'tool'
          writeln(aid, `\x1b[36m▸ ${kind} · ${str(update.title) ?? ''}\x1b[0m`)
          applySessionSignal(deps, agent, { kind: 'activity', tool: str(update.title) })
          break
        }
        case 'tool_call_update': {
          const status = str(update.status)
          if (status === 'completed' || status === 'failed') {
            writeln(aid, status === 'failed'
              ? `\x1b[31m  ✗ ${str(update.title) ?? 'tool'} failed\x1b[0m`
              : `\x1b[90m  ✓ done\x1b[0m`)
          }
          break
        }
        case 'plan': {
          flushChunks(aid)
          const entries = Array.isArray(update.entries) ? update.entries as Record<string, unknown>[] : []
          for (const entry of entries.slice(0, 12)) {
            const mark = entry.status === 'completed' ? '◆' : entry.status === 'in_progress' ? '▹' : '◇'
            writeln(aid, `\x1b[90m${mark} ${str(entry.content) ?? ''}\x1b[0m`)
          }
          break
        }
        default:
          break // unknown variants are extensions; tolerate silently
      }
      break
    }
    case 'permission': {
      flushChunks(aid)
      const params = e.params ?? {}
      const toolCall = params.toolCall as Record<string, unknown> | undefined
      const raw = Array.isArray(params.options) ? params.options as Record<string, unknown>[] : []
      const options = raw
        .map((o, i) => ({ num: i + 1, optionId: str(o.optionId) ?? '', label: str(o.name) ?? `option ${i + 1}`, kind: str(o.kind) ?? '' }))
        .filter(o => o.optionId)
      pendingPerms.set(aid, { requestId: e.requestId, options })
      const question = `Permission needed · ${str(toolCall?.title) ?? 'tool call'}`
      writeln(aid, `\x1b[33m▸ ${question}\x1b[0m`)
      if (agent.status !== 'needs') {
        markHookNeedsFlag(aid)
        deps.setNeedsInput(aid, question, options.map(o => ({ num: o.num, label: o.label })))
      }
      break
    }
    case 'response': {
      flushChunks(aid)
      const stop = str((e.result ?? {})?.stopReason)
      if (stop) writeln(aid, `\x1b[90m── ${stop.replace(/_/g, ' ')} ──\x1b[0m`)
      if (e.error) writeln(aid, `\x1b[31m── turn failed · ${str((e.error as Record<string, unknown>).message) ?? 'error'} ──\x1b[0m`)
      applySessionSignal(deps, agent, { kind: 'turn-end' })
      break
    }
    case 'error': {
      flushChunks(aid)
      writeln(aid, `\x1b[31m── acp ${e.stage ?? ''} failed · ${str((e.error as Record<string, unknown> | undefined)?.message) ?? 'error'} ──\x1b[0m`)
      break
    }
  }
}

/** Subscribe to protocol events; returns an unsubscribe function. */
export function attachAcpEvents(deps: AcpEventsDeps): () => void {
  const subscribe = deps.subscribe ?? onAcpEvent
  return subscribe(e => applyAcpEvent(deps, e))
}
