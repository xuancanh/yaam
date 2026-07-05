// Chat search indexer: keeps the embedded full-text index in sync with chat
// transcripts. Subscribes to the store directly but only re-arms its debounced
// rebuild when a chat transcript actually changes — unrelated PTY output never
// schedules a reindex. Self-contained lifecycle (owns its timer + subscription).
import { useCallback, useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import { useAppStore } from '../../core/store'
import * as native from '../../core/native'
import { chatTranscriptsChanged } from '../../infrastructure/persistence/subscribe'

export function useChatSearchIndexer(stateRef: MutableRefObject<AppState>): void {
  const timer = useRef<number | undefined>(undefined)
  const arm = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const docs = stateRef.current.agents
        .filter(a => a.kind === 'chat')
        .flatMap(a => (a.chatLog ?? [])
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ chatId: a.id, msgId: m.id, role: m.role, text: `${a.name}\n${m.text}` })))
      void native.chatSearchReindex(docs).catch(() => {})
    }, 1500)
  }, [stateRef])
  useEffect(() => useAppStore.subscribe((s, prev) => {
    if (chatTranscriptsChanged(s, prev)) arm()
  }), [arm])
}
