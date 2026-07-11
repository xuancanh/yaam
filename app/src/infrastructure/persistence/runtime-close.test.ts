// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Tauri context: the backend vetoes the OS close and emits close-requested; the
// runtime must flush persisted state and only then destroy the window.
let closeHandler: (() => void) | undefined
vi.mock('../../core/native', () => ({
  isTauri: true,
  saveStateFile: vi.fn(() => Promise.resolve()),
  saveSession: vi.fn(() => Promise.resolve()),
  removeSession: vi.fn(() => Promise.resolve()),
  secretSet: vi.fn(() => Promise.resolve()),
  secretDelete: vi.fn(() => Promise.resolve()),
  onCloseRequested: vi.fn((cb: () => void) => { closeHandler = cb; return () => { closeHandler = undefined } }),
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

beforeEach(() => { vi.clearAllMocks(); closeHandler = undefined })

describe('persistence runtime — Tauri close handshake', () => {
  it('registers a close handler that flushes then destroys the window', async () => {
    const rt = createPersistenceRuntime(store, { onToast: vi.fn() })
    rt.markReady()
    rt.start()

    expect(native.onCloseRequested).toHaveBeenCalledOnce()
    expect(closeHandler).toBeTypeOf('function')
    // no beforeunload fallback in the Tauri path
    expect(native.destroyWindow).not.toHaveBeenCalled()

    closeHandler!() // simulate the backend's vetoed close
    await vi.waitFor(() => expect(native.destroyWindow).toHaveBeenCalledOnce())
    expect(native.saveStateFile).toHaveBeenCalled() // state was flushed before destroy
  })

  it('unsubscribes the close handler on dispose', () => {
    const rt = createPersistenceRuntime(store, { onToast: vi.fn() })
    rt.start()
    expect(closeHandler).toBeTypeOf('function')
    rt.dispose()
    expect(closeHandler).toBeUndefined()
  })
})
