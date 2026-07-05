import { describe, expect, it } from 'vitest'
import { createActivityService } from './service'
import { createFakeStatePort } from '../../core/ports.fakes'
import type { AppState } from '../../core/types'

const baseState = (over: Partial<AppState> = {}): AppState => ({
  activeWorkspace: 'ws-a',
  workspaces: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }],
  workspaceData: { 'ws-b': { events: [], notifications: [] } },
  agents: [{ id: 'bg', workspaceId: 'ws-b' }, { id: 'orphan', workspaceId: 'gone' }],
  events: [], notifications: [],
  ...over,
} as unknown as AppState)

describe('createActivityService', () => {
  it('widOf routes to the session-owning workspace, else the active one', () => {
    const port = createFakeStatePort(baseState())
    const svc = createActivityService(port)
    expect(svc.widOf(port.get(), null)).toBe('ws-a')       // no session → active
    expect(svc.widOf(port.get(), 'bg')).toBe('ws-b')        // owned by a background ws
    expect(svc.widOf(port.get(), 'orphan')).toBe('ws-a')    // owner ws no longer exists → active
    expect(svc.widOf(port.get(), 'ghost')).toBe('ws-a')     // unknown session → active
  })

  it('logs an active-workspace event onto the root events list', () => {
    const port = createFakeStatePort(baseState())
    createActivityService(port).logEvent('edit', null, 'hello')
    expect(port.get().events[0]).toMatchObject({ type: 'edit', text: 'hello' })
    expect(port.get().workspaceData['ws-b'].events).toHaveLength(0)
  })

  it('stashes a background-session event in its own workspace, not the active view', () => {
    const port = createFakeStatePort(baseState())
    createActivityService(port).notify('done', 'Done', 'detail', 'bg')
    expect(port.get().notifications).toHaveLength(0)                        // not on the active view
    expect(port.get().workspaceData['ws-b'].notifications[0]).toMatchObject({ title: 'Done' })
  })

  it('drops an event whose owning workspace is missing (no crash)', () => {
    const port = createFakeStatePort(baseState({ workspaceData: {} }))
    createActivityService(port).logEvent('edit', 'bg', 'x') // ws-b has no data slice
    expect(port.get().events).toHaveLength(0) // routed to ws-b, which has no slice → dropped
  })
})
