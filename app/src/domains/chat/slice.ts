// Chat domain AppState slice.
import type { DurableAgent } from '../../core/entities'

/** Durable chat-agent memory by workspace id: distilled facts every chat agent in
 *  the workspace reads at turn start and appends to via the remember tool. */
export interface ChatSlice {
  chatMemory: Record<string, string>
  /** persistent chat identities; conversations hang off them */
  durableAgents: DurableAgent[]
}

/** The always-present generic assistant (not deletable; used when no
 *  specialized agent fits). No homeDir: it works out of defaultCwd with the
 *  shared workspace memory instead of a file brain. */
export function builtinAssistant(): DurableAgent {
  return {
    id: 'agent-default',
    name: 'Assistant',
    color: '#7FD1FF',
    role: 'general-purpose helper',
    charter: 'You are the general-purpose assistant for this workspace: answer questions, work with files, and handle one-off jobs that no specialized agent owns.',
    builtin: true,
    createdAt: 0,
  }
}

/** Initial chat slice for a fresh app state. */
export function freshChatSlice(): ChatSlice {
  return { chatMemory: {}, durableAgents: [builtinAssistant()] }
}
