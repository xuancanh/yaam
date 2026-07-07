// Master domain AppState slice. Imports only entity types (never core/types).
import type { Message } from '../../core/entities'

/** Master orchestrator runtime + conversation. */
export interface MasterSlice {
  masterBusy: boolean
  messages: Message[]
  /** Master tool calls blocked on the "Ask first" policy, awaiting the user */
  pendingToolApprovals: { id: string; toolId: string }[]
  /** in-flight watcher reply text per task, streamed into the task chat
   *  (transient — cleared when the turn completes) */
  taskStreams?: Record<string, string>
}

/** Initial Master slice, seeded with the greeting message. */
export function freshMasterSlice(): MasterSlice {
  return {
    masterBusy: false,
    pendingToolApprovals: [],
    messages: [
      {
        id: 'm1', role: 'master', kind: 'text',
        text: 'I’m Master. Give me a brain in Settings → Master Brain (any supported provider’s API key), then tell me what you need — I launch and command sessions, answer questions about them, and build schedules.',
      },
    ],
  }
}
