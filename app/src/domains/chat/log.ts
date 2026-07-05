// Chat transcript mutations: replace one message's text (streaming updates) and
// append one visible message (bounded). Pure dispatch transitions; used by the
// chat runner to grow/seal live bubbles. Composed into the provider's runtime.
import { useMemo } from 'react'
import type { ChatMsg } from '../../core/types'
import { dispatch } from '../../core/store'
import { mkId } from '../../shared/id'

export interface ChatLog {
  updateChatLog: (agentId: string, msgId: string, text: string) => void
  /** append one visible message; returns its id (approval flows resolve by id) */
  pushChatLog: (id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => string
}

export function useChatLog(): ChatLog {
  return useMemo(() => createChatLog(), [])
}

/** Plain (non-React) factory for the chat transcript mutations. */
export function createChatLog(): ChatLog {
  return {
    updateChatLog: (agentId, msgId, text) => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === agentId
          ? { ...a, chatLog: (a.chatLog ?? []).map(m => (m.id === msgId ? { ...m, text } : m)) }
          : a),
      }))
    },
    pushChatLog: (id, msg) => {
      const msgId = mkId('cm')
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, chatLog: [...(a.chatLog ?? []), { id: msgId, at: Date.now(), ...msg }].slice(-200) }
          : a),
      }))
      return msgId
    },
  }
}
