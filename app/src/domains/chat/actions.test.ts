import { describe, expect, it, vi } from 'vitest'
import type { Agent, AppState } from '../../core/types'
import { createChatActions } from './actions'

const native = vi.hoisted(() => ({ execCommand: vi.fn() }))
vi.mock('../../core/native', async importOriginal => ({
  ...await importOriginal<typeof import('../../core/native')>(),
  isTauri: true,
  execCommand: native.execCommand,
}))

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
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), compactChatContext: vi.fn(async () => ''), skillCatalogs: { current: new Map() },
    })

    actions.setChatComposer('chat-1', { draft: 'revised' })

    expect(state.agents[0].chatComposer?.draft).toBe('revised')
    expect(state.agents[0].chatComposer?.queue.map(q => q.id)).toEqual(['q1'])

    actions.setChatTags('chat-1', [' research ', 'research', 'Q3'])
    actions.setChatPinned('chat-1', true)
    actions.archiveChat('chat-1')
    expect(state.agents[0]).toMatchObject({ chatTags: ['research', 'Q3'], chatPinned: false, archived: true })
    actions.restoreChat('chat-1')
    expect(state.agents[0].archived).toBe(false)
    actions.setChatTokenBudget('chat-1', 12_345.4)
    expect(state.agents[0].chatTokenBudget).toBe(12_345)
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
      agents: [chat], tasks: [], skills: [], skillRegistries: [], chatAgentTypes: [], settings: {}, activeWorkspace: 'ws',
    } as unknown as AppState
    const stateRef = { current: state }
    const run = vi.fn()
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: run, stopChatMessage: vi.fn(), retryChatMessage: vi.fn(), replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), compactChatContext: vi.fn(async () => ''), skillCatalogs: { current: new Map() },
    })

    const id = actions.forkChatTurn('chat-1', 't2', 'revised')

    const fork = state.agents.find(a => a.id === id)
    expect(fork?.chatTurns?.map(t => t.id)).toEqual(['t1'])
    expect(fork?.chatLog?.map(m => m.id)).toEqual(['intro', 'm1'])
    expect({ used: fork?.used, cost: fork?.cost }).toEqual({ used: 0, cost: 0 })
    expect(run).toHaveBeenCalledWith(id, 'revised', [])

    const taskId = actions.promoteChatTurn('chat-1', 't2')
    expect(state.tasks.find(t => t.id === taskId)).toMatchObject({ title: 'two', col: 'backlog', agentId: null })
    expect(state.agents[0].chatTurns?.find(t => t.id === 't2')?.promotedTaskId).toBe(taskId)
  })

  it('setChatConfig switches type/model/effort and keeps the display line honest', () => {
    const chat = {
      id: 'chat-1', kind: 'chat', chatLog: [], log: [],
      chatTypeId: 'ct-a', chatModel: 'claude-sonnet-5', model: 'Claude · claude-sonnet-5',
    } as unknown as Agent
    let state = {
      agents: [chat], skills: [], skillRegistries: [],
      chatAgentTypes: [
        { id: 'ct-a', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5', enabled: true },
        { id: 'ct-b', name: 'DeepSeek', provider: 'deepseek', model: 'deepseek-chat', enabled: true },
      ],
      settings: {}, activeWorkspace: 'ws',
    } as unknown as AppState
    const stateRef = { current: state }
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: vi.fn(), stopChatMessage: vi.fn(), retryChatMessage: vi.fn(),
      replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), compactChatContext: vi.fn(async () => ''), skillCatalogs: { current: new Map() },
    })

    actions.setChatConfig('chat-1', { chatEffort: 'high' })
    expect(state.agents[0]).toMatchObject({ chatEffort: 'high', chatModel: 'claude-sonnet-5' })

    // switching the type resets the model to the new type's default
    actions.setChatConfig('chat-1', { chatTypeId: 'ct-b' })
    expect(state.agents[0]).toMatchObject({
      chatTypeId: 'ct-b', chatModel: 'deepseek-chat', model: 'DeepSeek · deepseek-chat',
      chatEffort: 'high', // persists — the runner gates it per model support
    })

    actions.setChatConfig('chat-1', { chatModel: 'deepseek-reasoner', chatEffort: null })
    expect(state.agents[0]).toMatchObject({ chatModel: 'deepseek-reasoner', model: 'DeepSeek · deepseek-reasoner' })
    expect(state.agents[0].chatEffort).toBeUndefined()
  })

  it('rateChatReply marks the message, toggles off, and files 👎 notes as memory', () => {
    const chat = {
      id: 'chat-1', kind: 'chat', log: [], workspaceId: 'ws',
      chatLog: [
        { id: 'm1', role: 'assistant', text: 'a long reply the user disliked', at: 1 },
        { id: 'm2', role: 'user', text: 'q', at: 2 },
      ],
    } as unknown as Agent
    let state = {
      agents: [chat], skills: [], skillRegistries: [], chatAgentTypes: [],
      settings: {}, activeWorkspace: 'ws', durableAgents: [], assistantMemory: {},
    } as unknown as AppState
    const stateRef = { current: state }
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: vi.fn(), stopChatMessage: vi.fn(), retryChatMessage: vi.fn(),
      replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), compactChatContext: vi.fn(async () => ''), skillCatalogs: { current: new Map() },
    })

    actions.rateChatReply('chat-1', 'm2', 'up') // user messages are not ratable
    expect(state.agents[0].chatLog?.[1].feedback).toBeUndefined()

    actions.rateChatReply('chat-1', 'm1', 'up')
    expect(state.agents[0].chatLog?.[0].feedback).toBe('up')
    actions.rateChatReply('chat-1', 'm1', 'up') // same thumb again un-rates
    expect(state.agents[0].chatLog?.[0].feedback).toBeUndefined()

    actions.rateChatReply('chat-1', 'm1', 'down', 'too verbose, lead with the answer')
    expect(state.agents[0].chatLog?.[0].feedback).toBe('down')
    // no durable home dir → the lesson lands in shared workspace memory
    const corrections = JSON.stringify(state.assistantMemory)
    expect(corrections).toContain('too verbose, lead with the answer')
    // and it queues for the agent's next turn so it acknowledges the change
    expect(state.agents[0].chatPendingFeedback).toEqual(['👎 too verbose, lead with the answer'])
  })

  it('gives a new agent a default home folder (and the hygiene loop) when none is specified', async () => {
    native.execCommand.mockResolvedValue({ code: 0, output: '/Users/u/YaamAgents/chef-remy\n' })
    let state = {
      agents: [], skills: [], skillRegistries: [], chatAgentTypes: [],
      settings: {}, activeWorkspace: 'ws', durableAgents: [], crons: [],
    } as unknown as AppState
    const stateRef = { current: state }
    const actions = createChatActions({
      stateRef,
      dispatch: update => { state = update(state); stateRef.current = state },
      logEvent: vi.fn(), runChatMessage: vi.fn(), stopChatMessage: vi.fn(), retryChatMessage: vi.fn(),
      replayChatMessage: vi.fn(),
      resetChatRuntime: vi.fn(), resolveChatApproval: vi.fn(), compactChatContext: vi.fn(async () => ''), skillCatalogs: { current: new Map() },
    })

    const id = actions.addDurableAgent({ name: 'Chef Remy' })
    await vi.waitFor(() => {
      expect(state.durableAgents?.find(d => d.id === id)?.homeDir).toBe('/Users/u/YaamAgents/chef-remy')
    })
    // the folder name comes from the slugged agent name (collision → suffix)
    expect(native.execCommand.mock.calls[0][0]).toContain('$HOME/YaamAgents/chef-remy')
    expect(state.crons.some(c => c.durableAgentId === id && c.name === 'consolidate-lessons')).toBe(true)

    // an explicit folder is respected — no provisioning, loop seeded directly
    native.execCommand.mockClear()
    const id2 = actions.addDurableAgent({ name: 'Scout', homeDir: '/tmp/scout' })
    expect(native.execCommand).not.toHaveBeenCalled()
    expect(state.durableAgents?.find(d => d.id === id2)?.homeDir).toBe('/tmp/scout')
  })
})
