// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../core/native', () => ({
  isTauri: false,
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

function baseState(over: Partial<AppState> = {}): AppState {
  return {
    schemaVersion: 1,
    tasks: [], crons: [], settings: { apiKey: '' }, toolsCatalog: [], agentTypes: [], templates: [],
    mcpServers: [], skills: [], skillRegistries: [], chatAgentTypes: [],
    workspaces: [], activeWorkspace: 'ws-a', workspaceData: {},
    agents: [], groups: [], activeGroup: null, minimizedIds: [], addons: [], addonStorage: {},
    messages: [], events: [], notifications: [], pendingMasterNotes: [], toast: '', composer: '',
    ...over,
  } as unknown as AppState
}

function fakeStore(initial: AppState) {
  let state = initial
  const listeners = new Set<(s: AppState, p: AppState) => void>()
  return {
    getState: () => state,
    subscribe: (fn: (s: AppState, p: AppState) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    listenerCount: () => listeners.size,
    set(next: AppState) { const prev = state; state = next; for (const l of [...listeners]) l(next, prev) },
  }
}

describe('createPersistenceRuntime', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not write before markReady() (protects on-disk state during load)', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start()
    store.set(baseState({ tasks: [{ id: 't' }] as unknown as AppState['tasks'] }))
    vi.advanceTimersByTime(1000)
    expect(native.saveStateFile).not.toHaveBeenCalled()
    rt.dispose()
  })

  it('start() is idempotent and dispose removes every subscription', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.start()
    expect(store.listenerCount()).toBe(3)
    rt.dispose()
    expect(store.listenerCount()).toBe(0)
  })

  it('debounces a main-partition save after a durable slice change', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    // immutable update: only the changed slice gets a new reference
    store.set({ ...store.getState(), tasks: [{ id: 't' }] as unknown as AppState['tasks'] })
    expect(native.saveStateFile).not.toHaveBeenCalled() // still within debounce
    vi.advanceTimersByTime(800)
    expect(native.saveStateFile).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('ignores transient (non-persisted) changes', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    // toast/composer change but every durable slice keeps its reference
    store.set({ ...store.getState(), toast: 'hi', composer: 'typing' })
    vi.advanceTimersByTime(1000)
    expect(native.saveStateFile).not.toHaveBeenCalled()
    rt.dispose()
  })

  it('writes only changed sessions and removes deleted ones', () => {
    const a1 = { id: 'a1', kind: 'real', cmd: 'x', log: [] } as unknown as AppState['agents'][number]
    const a2 = { id: 'a2', kind: 'real', cmd: 'y', log: [] } as unknown as AppState['agents'][number]
    const store = fakeStore(baseState({ agents: [a1, a2] as AppState['agents'] }))
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    // first pass persists both
    store.set(baseState({ agents: [a1, a2] as AppState['agents'] }))
    vi.advanceTimersByTime(800)
    expect(native.saveSession).toHaveBeenCalledTimes(2)
    vi.clearAllMocks()
    // a1 changes (new ref), a2 unchanged, and a3 added — only a1 + a3 written
    const a1b = { ...a1, log: [{ t: 'out', x: 'hi' }] } as unknown as AppState['agents'][number]
    const a3 = { id: 'a3', kind: 'real', cmd: 'z', log: [] } as unknown as AppState['agents'][number]
    store.set(baseState({ agents: [a1b, a2, a3] as AppState['agents'] }))
    vi.advanceTimersByTime(800)
    expect(native.saveSession).toHaveBeenCalledTimes(2)
    // a2 removed → its file is deleted
    vi.clearAllMocks()
    store.set(baseState({ agents: [a1b, a3] as AppState['agents'] }))
    vi.advanceTimersByTime(800)
    expect(native.removeSession).toHaveBeenCalledWith('a2')
    rt.dispose()
  })

  it('persists a newly-added session immediately (no debounce wait)', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    const chat = { id: 'chat-1', kind: 'chat', chatLog: [], log: [] } as unknown as AppState['agents'][number]
    store.set({ ...store.getState(), agents: [chat] as AppState['agents'] })
    // written right away — no need to advance the 800ms debounce
    expect(native.saveSession).toHaveBeenCalledTimes(1)
    expect(native.saveSession).toHaveBeenCalledWith('chat-1', expect.any(String))
    rt.dispose()
  })

  it('debounces content updates to an existing session (not immediate)', () => {
    const a1 = { id: 'a1', kind: 'real', cmd: 'x', log: [] } as unknown as AppState['agents'][number]
    const store = fakeStore(baseState({ agents: [a1] as AppState['agents'] }))
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    store.set({ ...store.getState(), agents: [a1] as AppState['agents'] }) // structural (a1 new vs empty saved) → immediate
    expect(native.saveSession).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    // same id, new ref (streaming content) → debounced, not immediate
    const a1b = { ...a1, log: [{ t: 'out', x: 'hi' }] } as unknown as AppState['agents'][number]
    store.set({ ...store.getState(), agents: [a1b] as AppState['agents'] })
    expect(native.saveSession).not.toHaveBeenCalled()
    vi.advanceTimersByTime(800)
    expect(native.saveSession).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('dispose() cancels a pending debounced write', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    store.set(baseState({ tasks: [{ id: 't' }] as unknown as AppState['tasks'] }))
    rt.dispose() // before the 800ms debounce elapses
    vi.advanceTimersByTime(2000)
    expect(native.saveStateFile).not.toHaveBeenCalled()
  })

  it('mirrors settings credentials and deletes removed dynamic accounts', async () => {
    const device = { id: 'phone-1', name: 'Phone', token: 'device-token', at: 1 }
    const store = fakeStore(baseState({ settings: { ...baseState().settings, remoteDevices: [device] } }))
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.keychainReady.add('remote.device.phone-1.token')
    rt.start(); rt.markReady()

    store.set({ ...store.getState(), settings: { ...store.getState().settings, remoteToken: 'new-url-token', remoteDevices: [] } })
    await vi.advanceTimersByTimeAsync(900)

    expect(native.secretSet).toHaveBeenCalledWith('remote.urlToken', 'new-url-token')
    expect(native.secretDelete).toHaveBeenCalledWith('remote.device.phone-1.token')
    expect(rt.keychainReady.has('remote.device.phone-1.token')).toBe(false)
    rt.dispose()
  })

  it('does not rewrite unchanged keychain credentials', async () => {
    const store = fakeStore(baseState({ settings: {
      ...baseState().settings,
      apiKey: 'master-key', githubToken: 'github-key',
    } }))
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.keychainReady.add('master.apiKey')
    rt.keychainReady.add('github.token')
    rt.start(); rt.markReady()

    store.set({
      ...store.getState(),
      settings: { ...store.getState().settings, remoteToken: 'new-remote-token' },
    })
    await vi.advanceTimersByTimeAsync(900)

    expect(native.secretSet).toHaveBeenCalledTimes(1)
    expect(native.secretSet).toHaveBeenCalledWith('remote.urlToken', 'new-remote-token')
    rt.dispose()
  })

  it('migrates a legacy plaintext credential once after hydration', async () => {
    const store = fakeStore(baseState({ settings: { ...baseState().settings, apiKey: 'legacy-key' } }))
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()

    await vi.advanceTimersByTimeAsync(900)
    expect(native.secretSet).toHaveBeenCalledTimes(1)
    expect(native.secretSet).toHaveBeenCalledWith('master.apiKey', 'legacy-key')

    store.set({ ...store.getState(), settings: { ...store.getState().settings } })
    await vi.advanceTimersByTimeAsync(900)
    expect(native.secretSet).toHaveBeenCalledTimes(1)
    rt.dispose()
  })

  it('satellite: markReady() never schedules a secret-migration save, even with plaintext credentials', async () => {
    // A satellite never resolves keychain secrets, so a legacy plaintext
    // credential in the loaded file would otherwise trigger armSecret()'s
    // re-save — a second writer racing the main window.
    const store = fakeStore(baseState({ settings: { ...baseState().settings, apiKey: 'legacy-key' } }))
    const rt = createPersistenceRuntime(store, { onToast: () => {}, isMain: false })
    rt.start(); rt.markReady()

    await vi.advanceTimersByTimeAsync(2000)
    expect(native.secretSet).not.toHaveBeenCalled()
    expect(native.saveStateFile).not.toHaveBeenCalled()
    rt.dispose()
  })

  it('satellite: writes no state or session files even when started + ready', () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {}, isMain: false })
    rt.start(); rt.markReady()

    store.set({ ...store.getState(), tasks: [{ id: 't' }] as unknown as AppState['tasks'] })
    const chat = { id: 'chat-1', kind: 'chat', chatLog: [], log: [] } as unknown as AppState['agents'][number]
    store.set({ ...store.getState(), agents: [chat] as AppState['agents'] })
    vi.advanceTimersByTime(2000)

    expect(native.saveStateFile).not.toHaveBeenCalled()
    expect(native.saveSession).not.toHaveBeenCalled()
    rt.dispose()
  })

  it('satellite: flush() is a no-op — main owns the files', async () => {
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {}, isMain: false })
    rt.start(); rt.markReady()
    await rt.flush()
    expect(native.saveStateFile).not.toHaveBeenCalled()
    expect(native.saveSession).not.toHaveBeenCalled()
    rt.dispose()
  })

  it('retries a persistently failing session write with backoff, gives up after 5 attempts, and re-arms on the next state change', async () => {
    const agent = { id: 'fail-1', kind: 'real', cmd: 'x', log: [] } as unknown as AppState['agents'][number]
    const store = fakeStore(baseState())
    const onToast = vi.fn()
    const rt = createPersistenceRuntime(store, { onToast })
    rt.start(); rt.markReady()
    vi.mocked(native.saveSession).mockRejectedValue(new Error('disk full'))

    store.set({ ...store.getState(), agents: [agent] }) // structural → immediate attempt #1
    expect(native.saveSession).toHaveBeenCalledTimes(1)

    // retries with doubling delays: 800, 1600, 3200, 6400 — then gives up
    await vi.advanceTimersByTimeAsync(800)
    expect(native.saveSession).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1600)
    expect(native.saveSession).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(3200)
    expect(native.saveSession).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(6400)
    expect(native.saveSession).toHaveBeenCalledTimes(5)

    // gave up — no more churn, and the toast fired exactly once for the streak
    await vi.advanceTimersByTimeAsync(120_000)
    expect(native.saveSession).toHaveBeenCalledTimes(5)
    expect(onToast).toHaveBeenCalledTimes(1)

    // the session stayed dirty: a real state change re-arms a write naturally
    const agent2 = { ...agent, log: [{ t: 'out', x: 'hi' }] } as unknown as AppState['agents'][number]
    store.set({ ...store.getState(), agents: [agent2] })
    await vi.advanceTimersByTimeAsync(800)
    expect(native.saveSession).toHaveBeenCalledTimes(6)
    rt.dispose()
  })

  it('recovers from a transient failure and stops retrying once the write lands', async () => {
    const agent = { id: 'flaky-1', kind: 'real', cmd: 'x', log: [] } as unknown as AppState['agents'][number]
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    vi.mocked(native.saveSession)
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValue(undefined)

    store.set({ ...store.getState(), agents: [agent] })
    await vi.advanceTimersByTimeAsync(800)
    expect(native.saveSession).toHaveBeenCalledTimes(2)

    // success reset the retry streak — no further writes without a state change
    await vi.advanceTimersByTimeAsync(60_000)
    expect(native.saveSession).toHaveBeenCalledTimes(2)
    rt.dispose()
  })

  it('retries failed session writes and removals without another state change', async () => {
    const agent = { id: 'retry-1', kind: 'real', cmd: 'x', log: [] } as unknown as AppState['agents'][number]
    const store = fakeStore(baseState())
    const rt = createPersistenceRuntime(store, { onToast: () => {} })
    rt.start(); rt.markReady()
    vi.mocked(native.saveSession)
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValue(undefined)

    store.set({ ...store.getState(), agents: [agent] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(800)
    expect(native.saveSession).toHaveBeenCalledTimes(2)

    vi.mocked(native.removeSession)
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValue(undefined)
    store.set({ ...store.getState(), agents: [] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(800)
    expect(native.removeSession).toHaveBeenCalledTimes(2)
    rt.dispose()
  })
})
