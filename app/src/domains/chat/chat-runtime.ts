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
import { runChatMessageTurn } from './runner'
import type { ChatAttachment } from './runner'

export interface ChatPorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  pushChatLog: (id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => void
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
  dispose: (id: string) => void
}

export function createChatRuntime(ports: ChatPorts): ChatRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const aborts = new AbortRegistry()
  const run = (agentId: string, text: string, atts?: ChatAttachment[]) => {
    void runChatMessageTurn({ ...ports, histories, busy, aborts }, agentId, text, atts)
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
      const log = ports.stateRef.current.agents.find(a => a.id === agentId)?.chatLog ?? []
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
    dispose: (id) => {
      aborts.abort(id) // cancel any in-flight chat reply for this session
      histories.delete(id)
      busy.delete(id)
    },
  }
}
