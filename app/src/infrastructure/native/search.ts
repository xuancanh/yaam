// Chat full-text search adapter: rebuild + query the embedded tantivy index.
// Browser build: reindex is a no-op (returns 0), search returns no hits.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'
import { expectObjectArray } from './validate'

export interface ChatSearchHit {
  chatId: string
  msgId: string
  role: string
  text: string
  score: number
}

export interface ChatSearchDoc { chatId: string; msgId: string; role: string; text: string }

const toRustDocs = (docs: ChatSearchDoc[]) =>
  docs.map(d => ({ chat_id: d.chatId, msg_id: d.msgId, role: d.role, text: d.text }))

/** Rebuild the embedded tantivy index from all chat messages (initial load). */
export async function chatSearchReindex(docs: ChatSearchDoc[]): Promise<number> {
  if (!isTauri) return 0
  return await invoke<number>('chat_search_reindex', { docs: toRustDocs(docs) })
}

/** Incrementally add/replace messages by msg id (a new/edited message). */
export async function chatSearchUpsert(docs: ChatSearchDoc[]): Promise<number> {
  if (!isTauri || !docs.length) return 0
  return await invoke<number>('chat_search_upsert', { docs: toRustDocs(docs) })
}

/** Incrementally remove messages from the index by msg id (deleted chat). */
export async function chatSearchRemove(msgIds: string[]): Promise<number> {
  if (!isTauri || !msgIds.length) return 0
  return await invoke<number>('chat_search_remove', { msgIds })
}

/** Full-text search across chats via the embedded engine. */
export async function chatSearch(query: string, limit?: number): Promise<ChatSearchHit[]> {
  if (!isTauri) return []
  const raw = await invoke('chat_search', { query, limit: limit ?? null })
  const hits = expectObjectArray(raw, ['chat_id', 'msg_id', 'role', 'text', 'score'], 'chatSearch')
  return hits.map(h => ({ chatId: h.chat_id as string, msgId: h.msg_id as string, role: h.role as string, text: h.text as string, score: h.score as number }))
}
