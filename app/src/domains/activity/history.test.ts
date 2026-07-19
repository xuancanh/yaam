import { describe, expect, it } from 'vitest'
import type { Agent, AppState, BoardTask } from '../../core/types'
import { createSessionActivity, withActivityTargets } from './history'

const agent = { id: 'a1', name: 'Worker', history: [] } as unknown as Agent
const task = { id: 't1', title: 'Fix login', col: 'progress', agentId: 'a1', agentIds: ['a1'] } as BoardTask
const state = { agents: [agent], tasks: [task], activeWorkspace: 'ws', workspaceData: {} } as unknown as AppState

describe('linked activity history', () => {
  it('writes one event identity to both the session and its task', () => {
    const event = createSessionActivity(state, 'a1', {
      category: 'work', actor: 'session', kind: 'progress', text: 'Tests passed',
    })
    const next = withActivityTargets(state, event, { sessionId: 'a1', taskId: 't1' })
    expect(next.agents[0].history?.[0]).toBe(event)
    expect(next.tasks[0].history?.[0]).toBe(event)
    expect(event).toMatchObject({ sessionId: 'a1', sessionName: 'Worker', taskId: 't1', taskTitle: 'Fix login' })
  })

  it('updates a task in a background workspace', () => {
    const background = {
      ...state,
      tasks: [],
      workspaceData: { other: { tasks: [task] } },
    } as unknown as AppState
    const event = createSessionActivity(background, 'a1', {
      category: 'work', actor: 'session', kind: 'complete', text: 'Done',
    }, 't1')
    const next = withActivityTargets(background, event, { sessionId: 'a1', taskId: 't1', workspaceId: 'other' })
    expect(next.workspaceData.other.tasks[0].history?.[0]).toBe(event)
  })
})
