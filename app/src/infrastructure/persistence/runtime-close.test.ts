// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

// The Tauri close→flush→destroy handshake is now owned by the role-aware app
// runtime (main flushes + closes its satellites; satellites hand off), NOT by
// the persistence runtime. Persistence must therefore register NO close handler
// under Tauri — it only keeps the plain-browser beforeunload fallback.
vi.mock('../../core/native', () => ({
  isTauri: true,
  saveStateFile: vi.fn(() => Promise.resolve()),
  saveSession: vi.fn(() => Promise.resolve()),
  removeSession: vi.fn(() => Promise.resolve()),
  secretSet: vi.fn(() => Promise.resolve()),
  secretDelete: vi.fn(() => Promise.resolve()),
  onCloseRequested: vi.fn(() => () => {}),
  destroyWindow: vi.fn(() => Promise.resolve()),
}))

import * as native from '../../core/native'
import { createPersistenceRuntime } from './runtime'
type AppState = import('../../core/types').AppState

const state = {
  schemaVersion: 1, tasks: [], crons: [], settings: { apiKey: '' }, toolsCatalog: [], agentTypes: [],
  templates: [], mcpServers: [], skills: [], skillRegistries: [], chatAgentTypes: [],
  workspaces: [{ id: 'ws-a', name: 'A' }], activeWorkspace: 'ws-a', workspaceData: {},
  agents: [{ id: 'a1', log: [] }], groups: [], activeGroup: null, minimizedIds: [], addons: [], addonStorage: {},
  messages: [], events: [], notifications: [],
} as unknown as AppState
const store = { getState: () => state, subscribe: () => () => {} }

beforeEach(() => { vi.clearAllMocks() })

describe('persistence runtime — no longer owns the Tauri close', () => {
  it('does not register a close handler under Tauri (the app runtime does)', () => {
    const rt = createPersistenceRuntime(store, { onToast: vi.fn() })
    rt.markReady()
    rt.start()
    expect(native.onCloseRequested).not.toHaveBeenCalled()
    expect(native.destroyWindow).not.toHaveBeenCalled()
  })

  it('still exposes flush() for the app runtime to call on close', async () => {
    const rt = createPersistenceRuntime(store, { onToast: vi.fn() })
    rt.markReady()
    rt.start()
    await rt.flush()
    expect(native.saveStateFile).toHaveBeenCalled()
  })
})
