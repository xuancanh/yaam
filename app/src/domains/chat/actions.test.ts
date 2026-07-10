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
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), skillCatalogs: { current: new Map() },
    })

    actions.setChatComposer('chat-1', { draft: 'revised' })

    expect(state.agents[0].chatComposer?.draft).toBe('revised')
    expect(state.agents[0].chatComposer?.queue.map(q => q.id)).toEqual(['q1'])
  })
})
