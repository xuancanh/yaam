// Pure state/linkage helpers for the durable activity timeline. Event creation
// happens before dispatch; these functions only attach a pre-built event to its
// session and/or task targets.
import type { AppState, HistoryEntry } from '../../core/types'
import { createHistoryEntry, prependHistory } from '../../core/history'
import type { HistoryInput } from '../../core/history'
import { findTaskForAgentInState, findTaskInState, updateLocatedTask } from '../board/task-state'

type ActivityInput = Omit<HistoryInput, 'sessionId' | 'sessionName' | 'taskId' | 'taskTitle'>

export function createSessionActivity(
  state: AppState,
  sessionId: string,
  input: ActivityInput,
  taskId?: string,
  taskTitle?: string,
): HistoryEntry {
  const session = state.agents.find(a => a.id === sessionId)
  const located = taskId ? findTaskInState(state, taskId) : findTaskForAgentInState(state, sessionId)
  return createHistoryEntry({
    ...input,
    sessionId,
    sessionName: session?.name ?? sessionId,
    taskId: located?.task.id,
    taskTitle: located?.task.title ?? taskTitle,
  })
}

export function createTaskActivity(
  state: AppState,
  taskId: string,
  input: ActivityInput,
  sessionId?: string,
): HistoryEntry {
  const located = findTaskInState(state, taskId)
  const session = sessionId ? state.agents.find(a => a.id === sessionId) : undefined
  return createHistoryEntry({
    ...input,
    taskId,
    taskTitle: located?.task.title ?? taskId,
    sessionId,
    sessionName: session?.name,
  })
}

export function withActivityTargets(
  state: AppState,
  entry: HistoryEntry,
  targets: { sessionId?: string; taskId?: string; workspaceId?: string; coalesce?: boolean },
): AppState {
  const prepend = (history: HistoryEntry[] | undefined) => prependHistory(history, entry, { coalesce: targets.coalesce })
  let next = targets.sessionId
    ? { ...state, agents: state.agents.map(a => a.id === targets.sessionId ? { ...a, history: prepend(a.history) } : a) }
    : state
  if (targets.taskId) {
    next = updateLocatedTask(next, targets.taskId, t => ({ ...t, history: prepend(t.history) }), targets.workspaceId)
  }
  return next
}
