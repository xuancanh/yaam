import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedState } from '../../core/data'
import type { Agent, DurableAgent } from '../../core/types'
import type { ApiMessage, LlmConfig } from '../../llm/client'
import { runChatTurn } from './agent'
import { compactConversation, rebuildChatHistory, reflectDurableConversation, shouldAutoCompact } from './runner'
import type { ChatCtx } from './runner'

const mocks = vi.hoisted(() => ({ callApi: vi.fn(), callApiStream: vi.fn() }))

vi.mock('../../llm/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../llm/client')>(),
  callApi: mocks.callApi,
  callApiStream: mocks.callApiStream,
  buildChatCfg: vi.fn(() => ({})),
  chatTypeHasCreds: vi.fn(() => true),
}))

function context() {
  const stateRef = { current: seedState() }
  const chat = {
    id: 'chat', kind: 'chat', name: 'Chat', status: 'idle', chatTypeId: stateRef.current.chatAgentTypes[0].id,
    chatLog: Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `message ${i}`, at: i + 1 })),
    log: [], memory: [], tools: [], used: 0, cost: 0,
  } as unknown as Agent
  stateRef.current = { ...stateRef.current, agents: [chat] }
  const histories = new Map<string, ApiMessage[]>([['chat', [{ role: 'user', content: 'old context' }]]])
  const ctx = {
    stateRef,
    histories,
    busy: new Set<string>(),
    dispatch: (fn: (s: typeof stateRef.current) => typeof stateRef.current) => { stateRef.current = fn(stateRef.current) },
    pushChatLog: vi.fn(() => 'notice'),
  } as unknown as ChatCtx
  return { ctx, stateRef, histories }
}

describe('auto-compact trigger (REL-9)', () => {
  beforeEach(() => mocks.callApiStream.mockReset())

  const agent = { id: 'chat', kind: 'chat', name: 'Chat', permMode: 'ask' } as unknown as Agent

  /** Drive one chat turn through scripted API rounds; bogus_tool resolves to
   *  an "unknown tool" result, keeping the loop self-contained. */
  async function runTurn(rounds: Array<Record<string, unknown>>) {
    for (const r of rounds) mocks.callApiStream.mockResolvedValueOnce(r)
    return runChatTurn({} as LlmConfig, () => agent, [], [], 'hello', [], () => {})
  }

  it('does not compact when the cumulative billed sum exceeds the limit but the last round does not', async () => {
    const usage = await runTurn([
      { content: [{ type: 'tool_use', id: 't1', name: 'bogus_tool', input: {} }], stop_reason: 'tool_use', usage: { inputTokens: 60_000, outputTokens: 100 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { inputTokens: 30_000, outputTokens: 50 } },
    ])

    // billing keeps the full sum (every round re-sends the history)…
    expect(usage).toMatchObject({ inputTokens: 90_000, outputTokens: 150 })
    // …but the trigger reads the actual context size (the last round)
    expect(usage?.contextInputTokens).toBe(30_000)
    expect(shouldAutoCompact(usage, 80_000)).toBe(false)
  })

  it('compacts when the last round itself reaches the limit', async () => {
    const usage = await runTurn([
      { content: [{ type: 'tool_use', id: 't1', name: 'bogus_tool', input: {} }], stop_reason: 'tool_use', usage: { inputTokens: 50_000, outputTokens: 100 } },
      { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { inputTokens: 85_000, outputTokens: 50 } },
    ])

    expect(usage?.contextInputTokens).toBe(85_000)
    expect(shouldAutoCompact(usage, 80_000)).toBe(true)
  })

  it('never compacts without usage or with the setting disabled', () => {
    expect(shouldAutoCompact(undefined, 80_000)).toBe(false)
    expect(shouldAutoCompact({ inputTokens: 200_000, outputTokens: 10, contextInputTokens: 200_000 }, 0)).toBe(false)
  })
})

describe('compactConversation', () => {
  beforeEach(() => mocks.callApi.mockReset())

  it('locks the chat until history has been reseeded', async () => {
    let resolve!: (value: unknown) => void
    mocks.callApi.mockReturnValue(new Promise(r => { resolve = r }))
    const { ctx, stateRef, histories } = context()

    const pending = compactConversation(ctx, 'chat')
    expect(ctx.busy.has('chat')).toBe(true)
    expect(stateRef.current.agents[0].status).toBe('running')
    await expect(compactConversation(ctx, 'chat')).resolves.toMatch(/mid-turn/)

    resolve({ content: [{ type: 'text', text: 'Dense summary' }] })
    await expect(pending).resolves.toMatch(/compacted/)
    expect(ctx.busy.has('chat')).toBe(false)
    expect(stateRef.current.agents[0]).toMatchObject({ status: 'idle', chatContextSummary: 'Dense summary' })
    expect(stateRef.current.agents[0].chatCompactedAt).toEqual(expect.any(Number))
    expect(histories.get('chat')).toHaveLength(2)
    expect(histories.get('chat')?.[0].content).toContain('Dense summary')
  })

  it('restarts from the compacted summary plus only newer visible messages', () => {
    const agent = {
      chatContextSummary: 'Earlier decisions', chatCompactedAt: 20,
      chatLog: [
        { role: 'user', text: 'old question', at: 10 },
        { role: 'assistant', text: 'old answer', at: 20 },
        { role: 'tool', text: 'context compacted', at: 21 },
        { role: 'user', text: 'new question', at: 30 },
        { role: 'assistant', text: 'new answer', at: 40 },
      ],
    } as Agent

    const history = rebuildChatHistory(agent)

    expect(history).toHaveLength(4)
    expect(history[0].content).toContain('Earlier decisions')
    expect(history.map(m => m.content)).toContain('new question')
    expect(history.map(m => m.content)).not.toContain('old question')
  })

  it('folds the previous summary together with only fresh messages', async () => {
    mocks.callApi.mockResolvedValue({ content: [{ type: 'text', text: 'Updated summary' }] })
    const { ctx, stateRef } = context()
    stateRef.current.agents[0] = {
      ...stateRef.current.agents[0],
      chatContextSummary: 'Durable earlier decision',
      chatCompactedAt: 4,
    }

    await compactConversation(ctx, 'chat', true)

    const request = JSON.stringify(mocks.callApi.mock.calls[0][2])
    expect(request).toContain('Durable earlier decision')
    expect(request).toContain('message 7')
    expect(request).not.toContain('message 0')
  })
})

describe('reflectDurableConversation', () => {
  beforeEach(() => mocks.callApi.mockReset())

  it('deduplicates overlapping reflections for one conversation', async () => {
    let resolve!: (value: unknown) => void
    mocks.callApi.mockReturnValue(new Promise(r => { resolve = r }))
    const { ctx, stateRef } = context()
    const durable: DurableAgent = { id: 'durable', name: 'Assistant', charter: 'Help', color: '#fff', builtin: true, createdAt: 1 }
    stateRef.current = {
      ...stateRef.current,
      durableAgents: [durable],
      agents: [{ ...stateRef.current.agents[0], durableAgentId: durable.id }],
    }

    const pending = reflectDurableConversation(ctx, 'chat', true)
    await expect(reflectDurableConversation(ctx, 'chat', true)).resolves.toBe('reflection already in progress')
    resolve({ content: [{ type: 'tool_use', name: 'submit_reflection', input: { journal: '- finished work', lessons: [] } }] })

    await expect(pending).resolves.toMatch(/reflected/)
    expect(stateRef.current.agents[0].reflectedAt).toEqual(expect.any(Number))
  })
})
