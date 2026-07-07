// Session domain AppState slice. Imports only entity types (never core/types),
// so core/types can compose this into AppState without an import cycle.
import type { Agent } from '../../core/entities'

/** Live sessions and session-view selection. */
export interface SessionSlice {
  agents: Agent[]
  /** chat session selected in the Chat view */
  activeChatId: string | null
  newSessionOpen: boolean
}

/** Initial session slice for a fresh app state. */
export function freshSessionSlice(): SessionSlice {
  return { agents: [], activeChatId: null, newSessionOpen: false }
}
