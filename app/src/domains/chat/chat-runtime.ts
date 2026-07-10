// Chat runtime: owns the per-chat registries (private API history, busy set,
// cancellation) and exposes run/stop/retry/dispose. Non-React factory wired
// with typed ports. The MCP-session and skill-catalog caches are shared (owned
// by the integration runtime) and passed in.
import type { MutableRefObject } from 'react'
import type { AppState, ChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { AbortRegistry } from '../../core/abort-registry'
import { reflectDurableConversation, runChatMessageTurn } from './runner'
import type { ChatAttachment } from './runner'
import { lastReplayableTurn, removeStructuredTurn, rewindFromTurn } from './turns'

export interface ChatPorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  pushChatLog: (id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => string
  updateChatLog: (agentId: string, msgId: string, text: string) => void
  flash: (t: string) => void
  refreshSkillCatalog: (id: string) => Promise<string>
}

export interface ChatRuntime {
  run: (agentId: string, text: string, atts?: ChatAttachment[]) => void
  /** cancel the in-flight reply; the runner's abort path settles status/busy */
  stop: (agentId: string) => void
  /** re-run the last user message: drop everything after it and send it again */
  retry: (agentId: string) => void
  replay: (agentId: string, turnId: string, text: string, atts?: ChatAttachment[]) => void
  /** answer a pending ask-mode tool approval (by its chat-message id) */
  resolveApproval: (agentId: string, msgId: string, decision: boolean | 'once' | 'always' | 'deny') => void
  /** manually distill one conversation into its durable agent's journal/lessons */
  reflect: (conversationId: string) => Promise<string>
  dispose: (id: string) => void
}

export function createChatRuntime(ports: ChatPorts): ChatRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const aborts = new AbortRegistry()
  const pendingApprovals = new Map<string, { agentId: string; key: string; resolve: (decision: 'once' | 'always' | 'deny') => void }>()
  const markApproval = (agentId: string, msgId: string, state: 'approved' | 'denied') => {
    ports.dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId
        ? { ...a, chatLog: (a.chatLog ?? []).map(m => (m.id === msgId ? { ...m, approval: state } : m)) }
        : a),
    }))
  }
  const run = (agentId: string, text: string, atts?: ChatAttachment[]) => {
    void runChatMessageTurn({ ...ports, histories, busy, aborts, pendingApprovals }, agentId, text, atts)
  }
  return {
    run,
    stop: (agentId) => {
      if (!busy.has(agentId)) return
      aborts.abort(agentId)
      ports.pushChatLog(agentId, { role: 'tool', text: 'stopped by user' })
    },
    retry: (agentId) => {
      if (busy.has(agentId)) return
      const agent = ports.stateRef.current.agents.find(a => a.id === agentId)
      const log = agent?.chatLog ?? []
      const turn = lastReplayableTurn(agent)
      if (turn) {
        ports.dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === agentId ? removeStructuredTurn(a, turn.id) : a),
        }))
        const h = histories.get(agentId)
        if (h) {
          while (h.length) {
            const e = h.pop()
            const blocks = Array.isArray(e?.content) ? e.content as Array<{ type?: string }> : []
            if (e?.role === 'user' && !blocks.some(b => b.type === 'tool_result')) break
          }
        }
        run(agentId, turn.input.text, turn.input.attachments)
        return
      }
      let idx = -1
      for (let i = log.length - 1; i >= 0; i--) if (log[i].role === 'user') { idx = i; break }
      if (idx < 0) return
      const text = log[idx].text
      // rewind the visible transcript to before that user message …
      ports.dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId ? { ...a, chatLog: (a.chatLog ?? []).slice(0, idx) } : a),
      }))
      // … and the private API history to before its matching user entry
      const h = histories.get(agentId)
      if (h) {
        while (h.length) {
          const e = h.pop()
          if (e && e.role === 'user' && typeof e.content === 'string') break
        }
      }
      run(agentId, text)
    },
    replay: (agentId, turnId, text, atts) => {
      if (busy.has(agentId)) return
      const agent = ports.stateRef.current.agents.find(a => a.id === agentId)
      const turn = agent?.chatTurns?.find(t => t.id === turnId)
      if (!agent || !turn) return
      ports.dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId ? rewindFromTurn(a, turnId) : a),
      }))
      histories.delete(agentId)
      run(agentId, text, atts ?? turn.input.attachments)
    },
    reflect: conversationId =>
      reflectDurableConversation({ ...ports, histories, busy, aborts, pendingApprovals }, conversationId, true),
    resolveApproval: (agentId, msgId, rawDecision) => {
      const pending = pendingApprovals.get(msgId)
      if (!pending || pending.agentId !== agentId) return
      pendingApprovals.delete(msgId)
      const decision = typeof rawDecision === 'boolean' ? (rawDecision ? 'once' : 'deny') : rawDecision
      markApproval(agentId, msgId, decision === 'deny' ? 'denied' : 'approved')
      if (decision === 'always') {
        ports.dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === agentId && !(a.approvedToolCalls ?? []).includes(pending.key)
            ? { ...a, approvedToolCalls: [...(a.approvedToolCalls ?? []), pending.key].slice(-100) }
            : a),
        }))
      }
      pending.resolve(decision)
    },
    dispose: (id) => {
      aborts.abort(id) // cancel any in-flight chat reply for this session
      for (const [msgId, p] of pendingApprovals) {
        if (p.agentId === id) { pendingApprovals.delete(msgId); p.resolve('deny') }
      }
      histories.delete(id)
      busy.delete(id)
    },
  }
}
