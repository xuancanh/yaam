import { describe, expect, it } from 'vitest'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from './task-state'
import type { AppState, BoardTask } from '../types'

const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask =>
  ({ id, title: id, col: 'backlog', agentId: null, ...extra })

// Minimal AppState: only the fields these locators read.
function mkState(): AppState {
  return {
    activeWorkspace: 'ws-a',
    tasks: [task('t1', { agentId: 'ag1' }), task('t2')],
    workspaceData: {
      'ws-b': { tasks: [task('t3', { agentId: 'ag3' })] },
    },
  } as unknown as AppState
}

describe('findTaskInState', () => {
  it('finds a task in the active workspace slice', () => {
    expect(findTaskInState(mkState(), 't1')).toEqual({ task: expect.objectContaining({ id: 't1' }), workspaceId: 'ws-a' })
  })
  it('finds a task in a background workspace slice', () => {
    expect(findTaskInState(mkState(), 't3')).toEqual({ task: expect.objectContaining({ id: 't3' }), workspaceId: 'ws-b' })
  })
  it('returns undefined for an unknown task', () => {
    expect(findTaskInState(mkState(), 'nope')).toBeUndefined()
  })
  it('honors a workspace hint for a background task', () => {
    expect(findTaskInState(mkState(), 't3', 'ws-b')?.workspaceId).toBe('ws-b')
  })
})

describe('findTaskForAgentInState', () => {
  it('finds by agent in the active slice', () => {
    expect(findTaskForAgentInState(mkState(), 'ag1')?.task.id).toBe('t1')
  })
  it('finds by agent in a background slice', () => {
    expect(findTaskForAgentInState(mkState(), 'ag3')).toEqual({ task: expect.objectContaining({ id: 't3' }), workspaceId: 'ws-b' })
  })
  it('returns undefined when no task owns the agent', () => {
    expect(findTaskForAgentInState(mkState(), 'ghost')).toBeUndefined()
  })
})

describe('updateLocatedTask', () => {
  it('updates a task in the active slice immutably', () => {
    const s = mkState()
    const next = updateLocatedTask(s, 't2', t => ({ ...t, col: 'done' }))
    expect(next.tasks.find(t => t.id === 't2')?.col).toBe('done')
    expect(s.tasks.find(t => t.id === 't2')?.col).toBe('backlog') // original untouched
  })
  it('updates a task inside a background workspace slice', () => {
    const next = updateLocatedTask(mkState(), 't3', t => ({ ...t, col: 'review' }))
    expect(next.workspaceData['ws-b'].tasks.find(t => t.id === 't3')?.col).toBe('review')
  })
  it('is a no-op for an unknown task', () => {
    const s = mkState()
    expect(updateLocatedTask(s, 'nope', t => ({ ...t, col: 'done' }))).toBe(s)
  })
})
