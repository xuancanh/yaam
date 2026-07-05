// Chat search indexer: keeps the embedded full-text index in sync with chat
// transcripts. Subscribes to the store directly but only re-arms its debounced
// sync when a chat transcript actually changes — unrelated PTY output never
// schedules work. The first sync does a full reindex; after that it diffs against
// the last-indexed set and applies only incremental upsert (new/edited) + remove
// (deleted) calls, so a single new message no longer rebuilds the whole index.
// A plain factory over StatePort + ClockPort; useChatSearchIndexer is a thin adapter.
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

export interface ChatSearchOps {
  reindex: (docs: ChatSearchDoc[]) => Promise<unknown>
  upsert: (docs: ChatSearchDoc[]) => Promise<unknown>
  remove: (msgIds: string[]) => Promise<unknown>
}

const SYNC_DEBOUNCE_MS = 1500

const defaultOps: ChatSearchOps = {
  reindex: docs => native.chatSearchReindex(docs).catch(() => {}),
  upsert: docs => native.chatSearchUpsert(docs).catch(() => {}),
  remove: ids => native.chatSearchRemove(ids).catch(() => {}),
}

export function createChatSearchIndexer(
  state: StatePort,
  clock: ClockPort = browserClock,
  ops: ChatSearchOps = defaultOps,
): ChatSearchIndexer {
  let timer: Disposable | undefined
  let unsub: (() => void) | undefined
  // msgId → indexed text; undefined until the first (full) sync completes
  let indexed: Map<string, string> | undefined

  const collect = (): ChatSearchDoc[] => state.get().agents
    .filter(a => a.kind === 'chat')
    .flatMap(a => (a.chatLog ?? [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ chatId: a.id, msgId: m.id, role: m.role, text: `${a.name}\n${m.text}` })))

  const sync = () => {
    const docs = collect()
    const next = new Map(docs.map(d => [d.msgId, d.text]))
    if (!indexed) {
      // first sync: full rebuild
      void ops.reindex(docs)
    } else {
      const changed = docs.filter(d => indexed!.get(d.msgId) !== d.text)
      const removed = [...indexed.keys()].filter(id => !next.has(id))
      if (changed.length) void ops.upsert(changed)
      if (removed.length) void ops.remove(removed)
    }
    indexed = next
  }

  const arm = () => {
    timer?.dispose()
    timer = clock.setTimeout(sync, SYNC_DEBOUNCE_MS)
  }

  return {
    start() { unsub ??= state.subscribe((s, prev) => { if (chatTranscriptsChanged(s, prev)) arm() }) },
    dispose() { timer?.dispose(); timer = undefined; unsub?.(); unsub = undefined; indexed = undefined },
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
