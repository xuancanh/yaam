// Chat search indexer: keeps the embedded full-text index in sync with chat
// transcripts. Subscribes to the store directly but only re-arms its debounced
// rebuild when a chat transcript actually changes — unrelated PTY output never
// schedules a reindex. A plain factory over StatePort + ClockPort with an
// explicit start/dispose lifecycle; useChatSearchIndexer is a thin React adapter.
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import { dispatch, useAppStore } from '../../core/store'
import { browserClock, type ClockPort, type Disposable, type StatePort } from '../../core/ports'
import * as native from '../../core/native'
import { chatTranscriptsChanged } from '../../infrastructure/persistence/subscribe'

export interface ChatSearchIndexer {
  start: () => void
  dispose: () => void
}

export interface ChatSearchDoc { chatId: string; msgId: string; role: string; text: string }

const REINDEX_DEBOUNCE_MS = 1500

export function createChatSearchIndexer(
  state: StatePort,
  clock: ClockPort = browserClock,
  reindex: (docs: ChatSearchDoc[]) => Promise<void> = async docs => { await native.chatSearchReindex(docs).catch(() => {}) },
): ChatSearchIndexer {
  let timer: Disposable | undefined
  let unsub: (() => void) | undefined

  const arm = () => {
    timer?.dispose()
    timer = clock.setTimeout(() => {
      const docs = state.get().agents
        .filter(a => a.kind === 'chat')
        .flatMap(a => (a.chatLog ?? [])
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ chatId: a.id, msgId: m.id, role: m.role, text: `${a.name}\n${m.text}` })))
      void reindex(docs)
    }, REINDEX_DEBOUNCE_MS)
  }

  return {
    start() { unsub ??= state.subscribe((s, prev) => { if (chatTranscriptsChanged(s, prev)) arm() }) },
    dispose() { timer?.dispose(); timer = undefined; unsub?.(); unsub = undefined },
  }
}

/** React adapter: index against the real store + browser clock. */
export function useChatSearchIndexer(stateRef: MutableRefObject<AppState>): void {
  useEffect(() => {
    const rt = createChatSearchIndexer({ get: () => stateRef.current, update: dispatch, subscribe: l => useAppStore.subscribe(l) })
    rt.start()
    return () => rt.dispose()
  }, [stateRef])
}
