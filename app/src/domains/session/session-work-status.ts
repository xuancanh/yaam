import type { Agent, BoardTask, HistoryEntry, SuggestedAction } from '../../core/types'

export interface SessionWorkStatus {
  task: string
  current: string
  next: string
  nextDetail?: string
}

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback

function latestWork(history: HistoryEntry[] | undefined): string | undefined {
  return (history ?? []).find(entry =>
    entry.actor !== 'user' && ['task', 'progress', 'changes', 'complete', 'fail'].includes(entry.kind))?.text
}

function taskSuggestion(task: BoardTask | undefined): SuggestedAction | undefined {
  const chat = task?.chat ?? []
  for (let i = chat.length - 1; i >= 0; i--) {
    const suggestion = chat[i].suggestions?.[0]
    if (suggestion) return suggestion
  }
  return undefined
}

/** One deterministic view of a run's task, present action, and next action.
 * Monitor/watcher statements win; durable history and lifecycle state are
 * bounded fallbacks for sessions that have not received a fresh LLM digest. */
export function sessionWorkStatus(agent?: Agent, task?: BoardTask): SessionWorkStatus {
  const suggestion = agent?.suggestions?.[0] ?? taskSuggestion(task)
  const current = agent?.summary
    || task?.watcherNote
    || latestWork(agent?.history)
    || (agent?.responding ? 'Producing terminal output' : undefined)
    || (agent?.status === 'running' ? 'Running in the terminal' : undefined)
    || (agent?.status === 'error' ? 'Session stopped with an error' : undefined)
    || (task && !agent ? 'Waiting to start' : 'Idle')

  let next = ''
  let nextDetail: string | undefined
  if (agent?.actionNeeded) next = agent.actionNeeded
  else if (suggestion) { next = suggestion.label; nextDetail = suggestion.send }
  else if (task?.awaitingUser || agent?.status === 'needs') next = 'Answer the pending question'
  else if (task?.col === 'review') next = 'Review changes and approve or request changes'
  else if (!agent && task && task.col !== 'done' && task.col !== 'failed') next = 'Start a session'
  else if (agent?.status === 'error') next = 'Inspect the failure, then resume or restart'
  else if (agent?.status === 'idle' && !agent.archived) next = 'Resume when ready'
  else if (task?.col === 'done' || agent?.archived) next = 'No further action'
  else next = 'Wait for the next checkpoint'

  return {
    task: text(task?.title || agent?.task, 'Unassigned session'),
    current: text(current, 'No current activity reported'),
    next,
    nextDetail,
  }
}
