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

export function rewindFromTurn(agent: Agent, turnId: string): Agent {
  const turns = agent.chatTurns ?? []
  const index = turns.findIndex(t => t.id === turnId)
  if (index < 0) return agent
  const removed = new Set(turns.slice(index).map(t => t.id))
  return {
    ...agent,
    chatLog: (agent.chatLog ?? []).filter(m => !m.turnId || !removed.has(m.turnId)),
    chatTurns: turns.slice(0, index),
  }
}
