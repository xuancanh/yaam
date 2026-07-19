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
    sandboxWrapper: vi.fn(async () => "sandbox-exec -f '/fake.sb'"),
    detachedSpawn: vi.fn(async () => 'attach-cmd'),
    detachedKill: vi.fn(async () => {}),
    restoreTerminalModes: vi.fn(),
    quiesceTerminal: vi.fn(),
    repaintTerminal: vi.fn(),
    terminalSize: vi.fn(() => ({ rows: 48, cols: 190 })),
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
  activeWorkspace: 'ws-a', workspaceData: { 'ws-b': {} }, detachedWorkspaces: [],
  agents: [], messages: [], events: [], notifications: [],
  groups: [], activeGroup: null, minimizedIds: [], crons: [], tasks: [],
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

describe('createWorkspaceActions.archiveWorkspace', () => {
  it('closes every session (including a detached workspace) and stores the state', () => {
    const port = fakePort()
    const h = harness(baseState({
      agents: [agent('a1', 'ws-b'), agent('a2', 'ws-b'), agent('keep', 'ws-a')],
      detachedWorkspaces: ['ws-b'],
      workspaceData: { 'ws-b': { tasks: [{ id: 't1' }] } as unknown as AppState['workspaceData'][string] },
    }), port)
    h.actions.archiveWorkspace('ws-b')

    expect(h.ctx.abortMaster).toHaveBeenCalledOnce()
    for (const id of ['a1', 'a2']) {
      expect(port.killSession).toHaveBeenCalledWith(id)
      expect(h.ctx.disposeSessionRuntime).toHaveBeenCalledWith(id)
      expect(port.removeSession).toHaveBeenCalledWith(id)
    }
    expect(port.killSession).not.toHaveBeenCalledWith('keep')
    const s = h.state()
    expect(s.workspaces.map(w => w.id)).toEqual(['ws-a'])
    expect(s.workspaceData['ws-b']).toBeUndefined()
    expect(s.detachedWorkspaces).not.toContain('ws-b')
    expect(s.agents.map(a => a.id)).toEqual(['keep'])
    // preserved under archive: the workspace, its slice, and paused sessions
    expect(s.archivedWorkspaces).toHaveLength(1)
    const entry = s.archivedWorkspaces[0]
    expect(entry.workspace).toEqual({ id: 'ws-b', name: 'B' })
    expect(entry.agents.map(a => a.id)).toEqual(['a1', 'a2'])
    expect(entry.agents.every(a => a.status === 'idle')).toBe(true) // processes killed
    expect(entry.data.tasks).toEqual([{ id: 't1' }])
  })

  it('ends a LOCAL detached session for real (detachedKill), not just the attach client', () => {
    const port = fakePort()
    const detached = { ...agent('det', 'ws-b'), detached: true } as Agent
    const h = harness(baseState({ agents: [detached] }), port)
    h.actions.archiveWorkspace('ws-b')
    expect(port.detachedKill).toHaveBeenCalledWith('det') // orphan host process ended
    expect(port.killSession).toHaveBeenCalledWith('det')
  })

  it('archiving the ACTIVE workspace switches this window away, snapshotting its live slice', () => {
    const port = fakePort()
    const h = harness(baseState({
      activeWorkspace: 'ws-a',
      tasks: [{ id: 'flat-task' }] as unknown as AppState['tasks'], // the flat = active (ws-a) slice
      agents: [agent('a1', 'ws-a')],
    }), port)
    h.actions.archiveWorkspace('ws-a')
    const s = h.state()
    expect(s.activeWorkspace).toBe('ws-b')
    expect(s.workspaces.map(w => w.id)).toEqual(['ws-b'])
    expect(port.killSession).toHaveBeenCalledWith('a1')
    const entry = s.archivedWorkspaces[0]
    expect(entry.workspace.id).toBe('ws-a')
    expect(entry.data.tasks).toEqual([{ id: 'flat-task' }]) // captured from the flat state
  })

  it('refuses to archive the last workspace and tears down nothing', () => {
    const port = fakePort()
    const h = harness(baseState({ workspaces: [{ id: 'ws-a', name: 'A' }], agents: [agent('a1', 'ws-a')] }), port)
    h.actions.archiveWorkspace('ws-a')
    expect(h.ctx.flash).toHaveBeenCalledWith('Cannot archive the last workspace')
    expect(port.killSession).not.toHaveBeenCalled()
    expect(h.state().workspaces).toHaveLength(1)
  })
})

describe('createWorkspaceActions restore / delete archived', () => {
  const archivedEntry = {
    workspace: { id: 'ws-x', name: 'X' },
    data: { tasks: [{ id: 't1' }], messages: [], crons: [] },
    agents: [agent('old', 'ws-x')],
    archivedAt: 123,
  } as unknown as NonNullable<AppState['archivedWorkspaces']>[number]

  it('restore brings the workspace back (inactive) with its paused sessions', () => {
    const h = harness(baseState({ archivedWorkspaces: [archivedEntry] }), fakePort())
    h.actions.restoreWorkspace('ws-x')
    const s = h.state()
    expect(s.workspaces.map(w => w.id)).toContain('ws-x')
    expect(s.activeWorkspace).toBe('ws-a') // stays inactive; the user switches to it
    expect(s.workspaceData['ws-x'].tasks).toEqual([{ id: 't1' }])
    expect(s.agents.map(a => a.id)).toContain('old')
    expect(s.archivedWorkspaces).toHaveLength(0)
  })

  it('deleteArchivedWorkspace drops it permanently and touches no sessions', () => {
    const port = fakePort()
    const h = harness(baseState({ archivedWorkspaces: [archivedEntry] }), port)
    h.actions.deleteArchivedWorkspace('ws-x')
    expect(h.state().archivedWorkspaces).toHaveLength(0)
    expect(port.killSession).not.toHaveBeenCalled()
  })
})

describe('createWorkspaceActions spin-out / restore', () => {
  it('detaching a non-active workspace hides it here without switching', () => {
    const h = harness(baseState(), fakePort())
    h.actions.openWorkspaceInWindow('ws-b')
    const s = h.state()
    expect(s.detachedWorkspaces).toContain('ws-b')
    expect(s.activeWorkspace).toBe('ws-a') // unchanged
  })

  it('detaching the active workspace switches this window away first', () => {
    const h = harness(baseState(), fakePort())
    h.actions.openWorkspaceInWindow('ws-a')
    const s = h.state()
    expect(s.detachedWorkspaces).toContain('ws-a')
    expect(s.activeWorkspace).toBe('ws-b') // main moved off the spun-out one
  })

  it('refuses to spin out when no other workspace would remain here', () => {
    const h = harness(baseState({ workspaces: [{ id: 'ws-a', name: 'A' }] }), fakePort())
    h.actions.openWorkspaceInWindow('ws-a')
    expect(h.ctx.flash).toHaveBeenCalledWith('Keep at least one workspace in this window')
    expect(h.state().detachedWorkspaces).not.toContain('ws-a')
  })

  it('reattach (satellite closed) restores it and merges its final slice', () => {
    const h = harness(baseState({ detachedWorkspaces: ['ws-b'] }), fakePort())
    const data = { tasks: [{ id: 't1' }] } as unknown as Parameters<typeof h.actions.reattachWorkspace>[1]
    h.actions.reattachWorkspace('ws-b', data, [agent('remote', 'ws-b')])
    const s = h.state()
    expect(s.detachedWorkspaces).not.toContain('ws-b') // selectable again
    expect(s.workspaceData['ws-b']).toBe(data)
    expect(s.agents.map(a => a.id)).toContain('remote')
  })

  it('periodic merge keeps the workspace detached', () => {
    const h = harness(baseState({ detachedWorkspaces: ['ws-b'] }), fakePort())
    const data = { tasks: [] } as unknown as Parameters<typeof h.actions.mergeDetachedWorkspace>[1]
    h.actions.mergeDetachedWorkspace('ws-b', data, [agent('remote', 'ws-b')])
    const s = h.state()
    expect(s.detachedWorkspaces).toContain('ws-b') // still in its own window
    expect(s.workspaceData['ws-b']).toBe(data)
  })
})

describe('createWorkspaceActions.moveSessionToWorkspace', () => {
  const group = (id: string, slots: (string | null)[]) => ({
    id, slots, stacked: false, activePane: 0, maximizedPane: null,
    splits: { row: 0.5, cols: [0.5, 0.5] },
  })

  it('re-homes an active-workspace session, pulling it out of groups and the dock', () => {
    const h = harness(baseState({
      agents: [agent('a1', 'ws-a'), agent('a2', 'ws-a')],
      groups: [group('g1', ['a1', 'a2'])],
      activeGroup: 'g1',
      minimizedIds: ['a1'],
    }), fakePort())
    h.actions.moveSessionToWorkspace('a1', 'ws-b')
    const s = h.state()
    expect(s.agents.find(a => a.id === 'a1')?.workspaceId).toBe('ws-b')
    expect(s.agents.find(a => a.id === 'a2')?.workspaceId).toBe('ws-a')
    expect(s.groups[0].slots).toEqual([null, 'a2'])
    expect(s.minimizedIds).not.toContain('a1')
    expect(h.ctx.flash).toHaveBeenCalledWith('Moved “a1” to B')
  })

  it('cleans the stashed slice when moving a session out of an inactive workspace', () => {
    const h = harness(baseState({
      agents: [agent('b1', 'ws-b')],
      workspaceData: {
        'ws-b': {
          groups: [group('gb', ['b1'])], activeGroup: 'gb', minimizedIds: ['b1'],
        } as unknown as AppState['workspaceData'][string],
      },
    }), fakePort())
    h.actions.moveSessionToWorkspace('b1', 'ws-a')
    const s = h.state()
    expect(s.agents.find(a => a.id === 'b1')?.workspaceId).toBe('ws-a')
    const slice = s.workspaceData['ws-b']
    expect(slice.groups).toEqual([]) // fully-emptied group pruned
    expect(slice.activeGroup).toBeNull()
    expect(slice.minimizedIds).not.toContain('b1')
  })

  it('refuses moves to or from a workspace open in its own window', () => {
    const h = harness(baseState({
      agents: [agent('a1', 'ws-a')],
      detachedWorkspaces: ['ws-b'],
    }), fakePort())
    h.actions.moveSessionToWorkspace('a1', 'ws-b')
    expect(h.state().agents.find(a => a.id === 'a1')?.workspaceId).toBe('ws-a')
    expect(h.ctx.flash).toHaveBeenCalledWith('Cannot move sessions to or from a workspace open in its own window')
  })

  it('no-ops when the target is the current workspace or unknown', () => {
    const h = harness(baseState({ agents: [agent('a1', 'ws-a')] }), fakePort())
    h.actions.moveSessionToWorkspace('a1', 'ws-a')
    h.actions.moveSessionToWorkspace('a1', 'ws-nope')
    h.actions.moveSessionToWorkspace('ghost', 'ws-b')
    expect(h.state().agents.find(a => a.id === 'a1')?.workspaceId).toBe('ws-a')
    expect(h.ctx.flash).not.toHaveBeenCalled()
  })
})

describe('createWorkspaceActions.switchWorkspace', () => {
  it('reclaims a detached workspace: waits for the satellite handoff, then switches', () => {
    const laterCalls: Array<() => void> = []
    const h = harness(baseState({ detachedWorkspaces: ['ws-b'] }), fakePort(), {
      later: (_ms, fn) => laterCalls.push(fn),
    })
    h.actions.switchWorkspace('ws-b')
    // not switched yet — the satellite still owns the workspace
    expect(h.state().activeWorkspace).toBe('ws-a')
    expect(h.ctx.flash).toHaveBeenCalledWith('Pulling the workspace back from its window…')
    laterCalls.shift()!() // first poll: satellite has not reattached yet
    expect(h.state().activeWorkspace).toBe('ws-a')
    // the satellite closed and handed its slice back (ws:reattach)
    h.actions.reattachWorkspace('ws-b', undefined, undefined)
    laterCalls.shift()!() // next poll sees the handoff and completes the switch
    expect(h.state().activeWorkspace).toBe('ws-b')
  })

  it('falls back to the synced copy when the satellite never responds', () => {
    const laterCalls: Array<() => void> = []
    const h = harness(baseState({ detachedWorkspaces: ['ws-b'] }), fakePort(), {
      later: (_ms, fn) => laterCalls.push(fn),
    })
    const now = vi.spyOn(Date, 'now')
    h.actions.switchWorkspace('ws-b')
    now.mockReturnValue(Date.now() + 10_000) // past the reclaim deadline
    laterCalls.shift()!()
    expect(h.state().activeWorkspace).toBe('ws-b')
    expect(h.state().detachedWorkspaces).not.toContain('ws-b')
    now.mockRestore()
  })
})
