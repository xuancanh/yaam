import type { Agent, ChatTurn } from '../../core/types'

export function lastReplayableTurn(agent: Agent | undefined): ChatTurn | undefined {
  return [...(agent?.chatTurns ?? [])].reverse().find(t => t.status !== 'running')
}

export function removeStructuredTurn(agent: Agent, turnId: string): Agent {
  return {
    ...agent,
    chatLog: (agent.chatLog ?? []).filter(m => m.turnId !== turnId),
    chatTurns: (agent.chatTurns ?? []).filter(t => t.id !== turnId),
  }
}
