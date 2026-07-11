import { describe, expect, it } from 'vitest'
import { applyScoped, scopedFromState, switchWorkspaceIn } from './state'
type AppState = import('../../core/types').AppState

function baseState(over: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 1,
    tasks: [], crons: [], settings: {}, toolsCatalog: [], agentTypes: [], templates: [],
    mcpServers: [], skills: [], skillRegistries: [], chatAgentTypes: [],
    workspaces: [{ id: 'ws-a', name: 'A' }], activeWorkspace: 'ws-a', workspaceData: {},
    agents: [], groups: [], activeGroup: null, minimizedIds: [], addons: [], addonStorage: {},
    messages: [], events: [], notifications: [], pendingMasterNotes: [],
    ...over,
  } as unknown as AppState
}

describe('workspace scoping round-trip', () => {
  it('scopedFromState + applyScoped preserve the active slice', () => {
    const s = baseState({
      tasks: [{ id: 't1', title: 't1', col: 'backlog', agentId: null }] as unknown as AppState['tasks'],
      crons: [{ id: 'c1', name: 'nightly' }] as unknown as AppState['crons'],
    })
    const scoped = scopedFromState(s)
    const applied = applyScoped(baseState(), scoped)
    expect(applied.tasks).toEqual(s.tasks)
    expect(applied.crons).toEqual(s.crons)
  })
  it('switchWorkspaceIn stashes the current slice and loads the target', () => {
    const s = baseState({
      workspaces: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }],
      activeWorkspace: 'ws-a',
      tasks: [{ id: 't-a', title: 'a', col: 'backlog', agentId: null }] as unknown as AppState['tasks'],
    })
    const next = switchWorkspaceIn(s, 'ws-b', 'hi')
    expect(next.activeWorkspace).toBe('ws-b')
    expect(next.tasks).toEqual([]) // fresh empty slice for ws-b
    expect(next.workspaceData['ws-a'].tasks).toEqual(s.tasks) // ws-a stashed
  })
  it('switchWorkspaceIn is a no-op for the current or an unknown workspace', () => {
    const s = baseState()
    expect(switchWorkspaceIn(s, 'ws-a', 'hi')).toBe(s)
    expect(switchWorkspaceIn(s, 'ghost', 'hi')).toBe(s)
  })

  // Invariant guard for finding #2: the scoped-field set is hand-enumerated in
  // scopedFromState/applyScoped, so a new WorkspaceData field that isn't wired
  // through both would be silently dropped on every workspace switch.
  it('scopedFromState captures exactly the workspace-scoped field set', () => {
    expect(Object.keys(scopedFromState(baseState())).sort()).toEqual([
      'activeGroup', 'crons', 'events', 'groups', 'messages',
      'minimizedIds', 'notifications', 'pendingMasterNotes', 'tasks',
    ])
  })
  it('applyScoped restores every durable scoped field onto state', () => {
    const slice = {
      groups: [], activeGroup: null, minimizedIds: ['m1'],
      messages: [{ id: 'x' }], crons: [{ id: 'c' }], tasks: [{ id: 't' }],
      events: [{ id: 'e' }], notifications: [{ id: 'n' }], pendingMasterNotes: [],
    } as unknown as Parameters<typeof applyScoped>[1]
    const out = applyScoped(baseState(), slice)
    expect(out.minimizedIds).toEqual(['m1'])
    expect(out.messages).toEqual([{ id: 'x' }])
    expect(out.crons).toEqual([{ id: 'c' }])
    expect(out.tasks).toEqual([{ id: 't' }])
    expect(out.events).toEqual([{ id: 'e' }])
    expect(out.notifications).toEqual([{ id: 'n' }])
  })
})
