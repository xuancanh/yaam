import type { Agent, ChatTurn } from '../../core/types'

export function buildContextSummary(turns: ChatTurn[], keepRecent = 12): string | undefined {
  const settled = turns.filter(t => t.status !== 'running')
  if (settled.length <= keepRecent) return undefined
  const older = settled.slice(0, -keepRecent).slice(-40)
  const lines = older.map(t => {
    const request = t.input.text.replace(/\s+/g, ' ').trim().slice(0, 220)
    const answer = (t.assistantText ?? t.error ?? '').replace(/\s+/g, ' ').trim().slice(0, 260)
    const tools = [...new Set(t.tools.map(tool => tool.name))].slice(0, 8)
    return `- ${new Date(t.at).toISOString().slice(0, 10)} | user: ${request}${answer ? ` | result: ${answer}` : ''}${tools.length ? ` | tools: ${tools.join(', ')}` : ''}`
  })
  const summary = lines.join('\n')
  return summary.length > 8_000 ? summary.slice(summary.length - 8_000) : summary
}

export function lastReplayableTurn(agent: Agent | undefined): ChatTurn | undefined {
  return [...(agent?.chatTurns ?? [])].reverse().find(t => t.status !== 'running')
}

export function removeStructuredTurn(agent: Agent, turnId: string): Agent {
  const next = {
    ...agent,
    chatLog: (agent.chatLog ?? []).filter(m => m.turnId !== turnId),
    chatTurns: (agent.chatTurns ?? []).filter(t => t.id !== turnId),
  }
  return { ...next, chatContextSummary: buildContextSummary(next.chatTurns ?? []) }
}

export function rewindFromTurn(agent: Agent, turnId: string): Agent {
  const turns = agent.chatTurns ?? []
  const index = turns.findIndex(t => t.id === turnId)
  if (index < 0) return agent
  const removed = new Set(turns.slice(index).map(t => t.id))
  const next = {
    ...agent,
    chatLog: (agent.chatLog ?? []).filter(m => !m.turnId || !removed.has(m.turnId)),
    chatTurns: turns.slice(0, index),
  }
  return { ...next, chatContextSummary: buildContextSummary(next.chatTurns ?? []) }
}
