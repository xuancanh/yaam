import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

vi.mock('../../core/terminals', () => ({ isAltScreen: () => false, readScreen: () => [] as string[] }))

import { createSessionAttention } from './attention'
import type { SessionAttentionCtx } from './attention'
import type { AppState, Agent } from '../../core/types'

const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'W', kind: 'real', status: 'running', log: [], ...over } as unknown as Agent)

function harness(agents: Agent[], extra: Partial<AppState> = {}) {
  const stateRef = {
    current: {
      agents, activeWorkspace: 'ws', detachedWorkspaces: [],
      workspaces: [{ id: 'ws', name: 'A' }, { id: 'ws-b', name: 'B' }],
      workspaceData: {},
      ...extra,
    } as unknown as AppState,
  } as MutableRefObject<AppState>
  const ctx: SessionAttentionCtx = {
    stateRef,
    widOf: () => 'ws',
    logEvent: vi.fn(),
    notify: vi.fn(),
    fireAddonHook: vi.fn(),
  }
  return { att: createSessionAttention(ctx), ctx, stateRef }
}

describe('createSessionAttention.setNeedsInput', () => {
  it('does not flag/notify for a session whose workspace is detached (satellite owns it)', () => {
    const h = harness([agent({ workspaceId: 'ws-b' })], { detachedWorkspaces: ['ws-b'] })
    h.att.setNeedsInput('a1', 'Allow this command?')
    expect(h.ctx.notify).not.toHaveBeenCalled()
    expect(h.ctx.logEvent).not.toHaveBeenCalled()
    expect(h.ctx.fireAddonHook).not.toHaveBeenCalled()
    expect(h.stateRef.current.agents[0].status).toBe('running') // untouched
  })

  it('flags a non-detached session as before', () => {
    const h = harness([agent({ workspaceId: 'ws' })], { detachedWorkspaces: ['ws-b'] })
    h.att.setNeedsInput('a1', 'Allow this command?')
    expect(h.ctx.notify).toHaveBeenCalledWith('escalate', expect.any(String), expect.any(String), 'a1')
    expect(h.ctx.logEvent).toHaveBeenCalledWith('escalate', 'a1', expect.any(String))
    expect(h.ctx.fireAddonHook).toHaveBeenCalledWith('onNeedsInput', expect.objectContaining({ sessionId: 'a1' }))
  })
})
