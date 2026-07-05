// Pure task-location helpers: board tasks live in the flat active-workspace
// slice OR in a background workspace's `workspaceData` slice, so locating and
// updating one means searching both. No React, no side effects.
import type { AppState, BoardTask } from '../types'

export interface LocatedTask {
  task: BoardTask
  workspaceId: string
}

/** Find a task across active and background workspace slices. */
export function findTaskInState(s: AppState, taskId: string, workspaceHint?: string): LocatedTask | undefined {
  if (!workspaceHint || workspaceHint === s.activeWorkspace) {
    const task = s.tasks.find(t => t.id === taskId)
    if (task) return { task, workspaceId: s.activeWorkspace }
  }
  if (workspaceHint && workspaceHint !== s.activeWorkspace) {
    const task = s.workspaceData[workspaceHint]?.tasks.find(t => t.id === taskId)
    if (task) return { task, workspaceId: workspaceHint }
  }
  for (const [workspaceId, data] of Object.entries(s.workspaceData)) {
    const task = data.tasks.find(t => t.id === taskId)
    if (task) return { task, workspaceId }
  }
  return undefined
}

/** Find the board task currently bound to a session in any workspace. */
export function findTaskForAgentInState(s: AppState, agentId: string): LocatedTask | undefined {
  const active = s.tasks.find(t => t.agentId === agentId)
  if (active) return { task: active, workspaceId: s.activeWorkspace }
  for (const [workspaceId, data] of Object.entries(s.workspaceData)) {
    const task = data.tasks.find(t => t.agentId === agentId)
    if (task) return { task, workspaceId }
  }
  return undefined
}

/** Immutably update a task in either the flat active slice or workspaceData. */
export function updateLocatedTask(
  s: AppState,
  taskId: string,
  update: (task: BoardTask) => BoardTask,
  workspaceHint?: string,
): AppState {
  const located = findTaskInState(s, taskId, workspaceHint)
  if (!located) return s
  if (located.workspaceId === s.activeWorkspace) {
    return { ...s, tasks: s.tasks.map(t => (t.id === taskId ? update(t) : t)) }
  }
  const data = s.workspaceData[located.workspaceId]
  if (!data) return s
  return {
    ...s,
    workspaceData: {
      ...s.workspaceData,
      [located.workspaceId]: { ...data, tasks: data.tasks.map(t => (t.id === taskId ? update(t) : t)) },
    },
  }
}
