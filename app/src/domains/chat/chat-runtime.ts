// Chat runtime: owns the per-chat registries (private API history, busy set,
// cancellation) and exposes run/dispose. Non-React factory wired with typed
// ports. The MCP-session and skill-catalog caches are shared (owned by the
// integration runtime) and passed in.
import type { MutableRefObject } from 'react'
import type { AppState, ChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import type { McpSession } from '../../core/mcp'
import type { CatalogSkill } from '../../core/skills'
import { AbortRegistry } from '../../core/abort-registry'
import { runChatMessageTurn } from './runner'

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
  run: (agentId: string, text: string) => void
  dispose: (id: string) => void
}

export function createChatRuntime(ports: ChatPorts): ChatRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const aborts = new AbortRegistry()
  return {
    run: (agentId, text) => { void runChatMessageTurn({ ...ports, histories, busy, aborts }, agentId, text) },
    dispose: (id) => {
      aborts.abort(id) // cancel any in-flight chat reply for this session
      histories.delete(id)
      busy.delete(id)
    },
  }
}
