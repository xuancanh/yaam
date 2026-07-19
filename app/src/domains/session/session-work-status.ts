import type { Agent, BoardTask, SuggestedAction } from '../../core/types'

export interface SessionWorkStatus {
  task: string
  current: string
  next: string
  nextDetail?: string
}

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback

function taskSuggestion(task: BoardTask | undefined): SuggestedAction | undefined {
  const chat = task?.chat ?? []
  for (let i = chat.length - 1; i >= 0; i--) {
    const suggestion = chat[i].suggestions?.[0]
    if (suggestion) return suggestion
  }
  return undefined
}

function watcherQuestion(task: BoardTask | undefined): string | undefined {
  if (!task?.awaitingUser) return undefined
  const chat = task.chat ?? []
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].role === 'watcher' && chat[i].text.trim()) return chat[i].text.trim()
  }
  return undefined
}

/** One deterministic view of a run's task, present action, and next action.
 * Monitor/watcher statements win; lifecycle placeholders are used only until
 * the first synthesized status brief arrives. Raw terminal output and
 * extractive terminal summaries never enter this view. */
export function sessionWorkStatus(agent?: Agent, task?: BoardTask): SessionWorkStatus {
  const suggestion = taskSuggestion(task) ?? agent?.suggestions?.[0]
  const current = task?.watcherNote
    || agent?.summary
    || (agent?.responding ? 'Working · watcher summary pending' : undefined)
    || (agent?.status === 'running' ? 'Running · watcher summary pending' : undefined)
    || (agent?.status === 'error' ? 'Session stopped with an error' : undefined)
    || (task && !agent ? 'Waiting to start' : 'Idle')

  let next = ''
  let nextDetail: string | undefined
  if (agent?.actionNeeded) next = agent.actionNeeded
  else if (task?.awaitingUser) next = watcherQuestion(task) || task.watcherNext || 'Answer the watcher\'s pending question'
  else if (suggestion) { next = suggestion.label; nextDetail = suggestion.send }
  else if (task?.watcherNext || agent?.nextAction) next = task?.watcherNext || agent?.nextAction || ''
  else if (agent?.status === 'needs') next = 'Answer the monitor\'s pending question'
  else if (task?.col === 'review') next = 'Review changes and approve or request changes'
  else if (!agent && task && task.col !== 'done' && task.col !== 'failed') next = 'Start a session'
  else if (agent?.status === 'error') next = 'Inspect the failure, then resume or restart'
  else if (agent?.status === 'idle' && !agent.archived) next = 'Resume when ready'
  else if (task?.col === 'done' || agent?.archived) next = 'No further action'
  else next = 'Wait for the next checkpoint'

  return {
    task: text(task?.title || agent?.task, 'Waiting for watcher task summary'),
    current: text(current, 'No current activity reported'),
    next,
    nextDetail,
  }
}
