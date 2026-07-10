import { describe, expect, it, vi } from 'vitest'
import type { Agent, AppState } from '../../core/types'
import { createChatActions } from './actions'

describe('chat composer actions', () => {
  it('merges durable composer patches without dropping queued work', () => {
    const chat = {
      id: 'chat-1', kind: 'chat', chatLog: [], log: [],
      chatComposer: {
        draft: 'draft', attachments: [],
        queue: [{ id: 'q1', at: 1, text: 'queued', attachments: [] }],
      },
    } as unknown as Agent
    let state = {
      agents: [chat], skills: [], skillRegistries: [], chatAgentTypes: [],
      settings: {}, activeWorkspace: 'ws',
    } as unknown as AppState
    const stateRef = { current: state }
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: vi.fn(), stopChatMessage: vi.fn(), retryChatMessage: vi.fn(),
      replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), skillCatalogs: { current: new Map() },
    })

    actions.setChatComposer('chat-1', { draft: 'revised' })

    expect(state.agents[0].chatComposer?.draft).toBe('revised')
    expect(state.agents[0].chatComposer?.queue.map(q => q.id)).toEqual(['q1'])
  })

  it('forks before the selected turn and runs the revised input in the new chat', () => {
    const turns = [
      { id: 't1', at: 1, startedAt: 1, status: 'complete' as const, model: 'm', input: { text: 'one', attachments: [] }, tools: [] },
      { id: 't2', at: 2, startedAt: 2, status: 'complete' as const, model: 'm', input: { text: 'two', attachments: [] }, tools: [] },
    ]
    const chat = {
      id: 'chat-1', name: 'Research', short: 'RE', kind: 'chat', status: 'idle', used: 4, cost: 2,
      chatTurns: turns, log: [], chatLog: [
        { id: 'intro', role: 'assistant', text: 'hi', at: 0 },
        { id: 'm1', role: 'user', text: 'one', at: 1, turnId: 't1' },
        { id: 'm2', role: 'user', text: 'two', at: 2, turnId: 't2' },
      ],
    } as unknown as Agent
    let state = {
      agents: [chat], skills: [], skillRegistries: [], chatAgentTypes: [], settings: {}, activeWorkspace: 'ws',
    } as unknown as AppState
    const stateRef = { current: state }
    const run = vi.fn()
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: run, stopChatMessage: vi.fn(), retryChatMessage: vi.fn(), replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), skillCatalogs: { current: new Map() },
    })

    const id = actions.forkChatTurn('chat-1', 't2', 'revised')

    const fork = state.agents.find(a => a.id === id)
    expect(fork?.chatTurns?.map(t => t.id)).toEqual(['t1'])
    expect(fork?.chatLog?.map(m => m.id)).toEqual(['intro', 'm1'])
    expect({ used: fork?.used, cost: fork?.cost }).toEqual({ used: 0, cost: 0 })
    expect(run).toHaveBeenCalledWith(id, 'revised', [])
  })
})
