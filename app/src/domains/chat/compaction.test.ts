import { beforeEach, describe, expect, it, vi } from 'vitest'
import { seedState } from '../../core/data'
import type { Agent } from '../../core/types'
import type { ApiMessage } from '../../llm/client'
import { compactConversation } from './runner'
import type { ChatCtx } from './runner'

const mocks = vi.hoisted(() => ({ callApi: vi.fn() }))

vi.mock('../../llm/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../llm/client')>(),
  callApi: mocks.callApi,
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
    expect(histories.get('chat')).toHaveLength(2)
    expect(histories.get('chat')?.[0].content).toContain('Dense summary')
  })
})
