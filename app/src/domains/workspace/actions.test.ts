import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions } from './actions'
import type { WorkspaceActionsCtx } from './actions'
import type { SessionProcessPort } from '../session/ports'
import type { AppState, Agent } from '../../core/types'
import type { MutableRefObject } from 'react'

const agent = (id: string, workspaceId: string): Agent =>
  ({ id, name: id, workspaceId, status: 'running', kind: 'real', log: [] } as unknown as Agent)

function fakePort(over: Partial<SessionProcessPort> = {}): SessionProcessPort {
  return {
    isTauri: false,
    spawnSession: vi.fn(async () => {}), killSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}),
    writeSession: vi.fn(async () => {}), sendLine: vi.fn(), detectCliSession: vi.fn(async () => null),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    restoreTerminalModes: vi.fn(),
    resetTerminal: vi.fn(),
    attachTerminal: vi.fn(() => ({ writeln: vi.fn() })), disposeTerminal: vi.fn(), isAltScreen: vi.fn(() => false),
    ...over,
  }
}

// A local mutable-state harness (workspace actions take dispatch as a ctx port,
// so we don't need the global store here).
function harness(initial: AppState, port: SessionProcessPort, over: Partial<WorkspaceActionsCtx> = {}) {
  let state = initial
  const ctx: WorkspaceActionsCtx = {
    dispatch: fn => { state = fn(state) },
    stateRef: { get current() { return state } } as MutableRefObject<AppState>,
    later: vi.fn(),
    flash: vi.fn(),
    runMaster: vi.fn(),
    markUserStopped: vi.fn(),
    disposeSessionRuntime: vi.fn(),
    abortMaster: vi.fn(),
    port,
    ...over,
  }
  return { ctx, actions: createWorkspaceActions(ctx), state: () => state }
}

const baseState = (over: Partial<AppState> = {}): AppState => ({
  workspaces: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }],
  activeWorkspace: 'ws-a', workspaceData: { 'ws-b': {} },
  agents: [], messages: [], events: [], notifications: [],
  ...over,
} as unknown as AppState)

describe('createWorkspaceActions.deleteWorkspace', () => {
  it('kills, disposes, and removes every session in the deleted workspace, then drops it', () => {
    const port = fakePort()
    const h = harness(baseState({
      agents: [agent('a1', 'ws-b'), agent('a2', 'ws-b'), agent('keep', 'ws-a')],
    }), port)
    h.actions.deleteWorkspace('ws-b')

    expect(h.ctx.abortMaster).toHaveBeenCalledOnce() // cancel any in-flight Master turn
    for (const id of ['a1', 'a2']) {
      expect(h.ctx.markUserStopped).toHaveBeenCalledWith(id)
      expect(port.killSession).toHaveBeenCalledWith(id)
      expect(h.ctx.disposeSessionRuntime).toHaveBeenCalledWith(id)
      expect(port.removeSession).toHaveBeenCalledWith(id)
    }
    // the untouched workspace's session is left alone
    expect(port.killSession).not.toHaveBeenCalledWith('keep')
    const s = h.state()
    expect(s.workspaces.map(w => w.id)).toEqual(['ws-a'])
    expect(s.workspaceData['ws-b']).toBeUndefined()
    expect(s.agents.map(a => a.id)).toEqual(['keep'])
  })

  it('refuses to delete the last workspace and tears down nothing', () => {
    const port = fakePort()
    const h = harness(baseState({ workspaces: [{ id: 'ws-a', name: 'A' }], agents: [agent('a1', 'ws-a')] }), port)
    h.actions.deleteWorkspace('ws-a')
    expect(h.ctx.flash).toHaveBeenCalledWith('Cannot delete the last workspace')
    expect(port.killSession).not.toHaveBeenCalled()
    expect(h.state().workspaces).toHaveLength(1)
  })
})
