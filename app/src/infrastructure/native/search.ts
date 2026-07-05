// Chat full-text search adapter: rebuild + query the embedded tantivy index.
// Browser build: reindex is a no-op (returns 0), search returns no hits.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface ChatSearchHit {
  chatId: string
  msgId: string
  role: string
  text: string
  score: number
}

/** Rebuild the embedded tantivy index from all chat messages. */
export async function chatSearchReindex(docs: { chatId: string; msgId: string; role: string; text: string }[]): Promise<number> {
  if (!isTauri) return 0
  return await invoke<number>('chat_search_reindex', {
    docs: docs.map(d => ({ chat_id: d.chatId, msg_id: d.msgId, role: d.role, text: d.text })),
  })
}

/** Full-text search across chats via the embedded engine. */
export async function chatSearch(query: string, limit?: number): Promise<ChatSearchHit[]> {
  if (!isTauri) return []
  const hits = await invoke<{ chat_id: string; msg_id: string; role: string; text: string; score: number }[]>('chat_search', { query, limit: limit ?? null })
  return hits.map(h => ({ chatId: h.chat_id, msgId: h.msg_id, role: h.role, text: h.text, score: h.score }))
}
