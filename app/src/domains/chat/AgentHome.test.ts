import { describe, expect, it } from 'vitest'
import type { Agent } from '../../core/types'
import { homeConversations } from './agent-home-state'

const chat = (id: string, workspaceId: string, at: number, extra: Partial<Agent> = {}) => ({
  id, kind: 'chat', workspaceId, durableAgentId: 'durable', archived: false,
  chatLog: [{ id: `m-${id}`, role: 'user', text: id, at }],
  ...extra,
}) as unknown as Agent

describe('homeConversations', () => {
  it('shows only active-workspace chats and orders newest first', () => {
    const agents = [
      chat('older', 'active', 10),
      chat('background', 'other', 30),
      chat('newer', 'active', 20),
      chat('archived', 'active', 40, { archived: true }),
      chat('different-agent', 'active', 50, { durableAgentId: 'other' }),
    ]

    expect(homeConversations(agents, 'durable', 'active').map(a => a.id)).toEqual(['newer', 'older'])
  })
})
