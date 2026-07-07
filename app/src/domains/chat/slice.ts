// Chat domain AppState slice.

/** Durable chat-agent memory by workspace id: distilled facts every chat agent in
 *  the workspace reads at turn start and appends to via the remember tool. */
export interface ChatSlice {
  chatMemory: Record<string, string>
}

/** Initial chat slice for a fresh app state. */
export function freshChatSlice(): ChatSlice {
  return { chatMemory: {} }
}
