import { describe, expect, it } from 'vitest'
import { attentionTotal, nextAttention, rollupByWorkspace } from './attention-rollup'
import type { AppState } from '../../core/types'

const st = (agents: Record<string, unknown>[], extra: Partial<AppState> = {}) => ({
  agents, workspaces: [{ id: 'w1' }, { id: 'w2' }], activeWorkspace: 'w1', detachedWorkspaces: [], ...extra,
}) as unknown as AppState

const s = st([
  { id: 'a', status: 'running', workspaceId: 'w1' },
  { id: 'b', status: 'running', attention: true, workspaceId: 'w1' },
  { id: 'c', status: 'needs', workspaceId: 'w2' },
  { id: 'd', status: 'needs', workspaceId: 'w1' },
  { id: 'e', status: 'needs', workspaceId: 'w1', archived: true },
  { id: 'f', status: 'running', attention: true, kind: 'chat', workspaceId: 'w1' },
])

describe('attention rollup', () => {
  it('counts blocked and unseen per workspace, ignoring archived and chats', () => {
    expect(rollupByWorkspace(s).get('w1')).toEqual({ blocked: 1, unseen: 1 })
    expect(rollupByWorkspace(s).get('w2')).toEqual({ blocked: 1, unseen: 0 })
    expect(attentionTotal(s)).toBe(3)
    expect(attentionTotal({ ...s, detachedWorkspaces: ['w2'] })).toBe(2)
  })

  it('jumps blocked first, active workspace first, then cycles', () => {
    expect(nextAttention(s)).toEqual({ id: 'd', workspaceId: 'w1' })
    expect(nextAttention(s, 'd')).toEqual({ id: 'c', workspaceId: 'w2' })
    expect(nextAttention(s, 'c')).toEqual({ id: 'b', workspaceId: 'w1' })
    expect(nextAttention(s, 'b')).toEqual({ id: 'd', workspaceId: 'w1' })
    expect(nextAttention(st([{ id: 'a', status: 'running' }]))).toBeNull()
  })
})
