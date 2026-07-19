// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nativeMocks = vi.hoisted(() => ({
  liveSessions: vi.fn(async (): Promise<string[]> => []),
  detachedList: vi.fn(async () => [] as Array<{ id: string; command: string; cwd: string | null; running: boolean; attach: string }>),
  spawnSession: vi.fn(async () => {}),
  secretGet: vi.fn(async () => null as string | null),
}))
const terminalMocks = vi.hoisted(() => ({
  writeln: vi.fn(),
  repaintSession: vi.fn(),
}))
const loaderMocks = vi.hoisted(() => ({ loadSnapshot: vi.fn() }))

vi.mock('../../core/native', () => nativeMocks)
vi.mock('../../core/terminals', () => ({
  getTerminal: vi.fn(() => ({ term: { rows: 31, cols: 97, writeln: terminalMocks.writeln } })),
  repaintSession: terminalMocks.repaintSession,
}))
vi.mock('./loaders', () => loaderMocks)

import { seedState } from '../../core/data'
import { useAppStore } from '../../core/store'
import type { AppState, Agent } from '../../core/types'
import { runHydration } from './hydrate-effect'

const detachedAgent = (): Agent => ({
  id: 'det-1', name: 'Detached', short: 'DE', color: '#fff', repo: 'repo', branch: 'live',
  status: 'running', model: 'claude', kind: 'real', cmd: 'old-attach-command', cwd: '/repo',
  launchedAt: 1, detached: true, log: [], memory: [], tools: [],
} as unknown as Agent)

function context(resolveSecrets = true) {
  const stateRef = { get current() { return useAppStore.getState() } } as { current: AppState }
  return {
    stateRef,
    persistence: { keychainReady: new Set<string>(), markReady: vi.fn(), start: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn() },
    startIntegrations: vi.fn(), appendTail: vi.fn(), clearNeeds: vi.fn(), bumpSettle: vi.fn(), armResponseWatch: vi.fn(),
    resolveSecrets,
  }
}

describe('detached runtime hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeMocks.liveSessions.mockResolvedValue([])
    nativeMocks.detachedList.mockResolvedValue([])
    nativeMocks.spawnSession.mockResolvedValue(undefined)
    nativeMocks.secretGet.mockResolvedValue(null)
    useAppStore.setState(seedState(), true)
    loaderMocks.loadSnapshot.mockResolvedValue({
      merged: { agents: [detachedAgent()], workspaces: [{ id: 'ws-default', name: 'Default' }], activeWorkspace: 'ws-default' },
      usedBackup: false,
    })
  })

  it('automatically attaches a surviving detached host with the current binary command', async () => {
    nativeMocks.detachedList.mockResolvedValue([{
      id: 'det-1', command: 'claude', cwd: '/repo', running: true, attach: 'current-attach-command',
    }])
    runHydration(context())
    await vi.waitFor(() => expect(nativeMocks.spawnSession).toHaveBeenCalledWith(
      'det-1', 'current-attach-command', '/repo', 31, 97, undefined, undefined,
    ))
    await vi.waitFor(() => expect(useAppStore.getState().agents[0]).toMatchObject({
      id: 'det-1', cmd: 'current-attach-command', status: 'running',
    }))
  })

  it('does not duplicate an attach wrapper that survived a webview reload', async () => {
    nativeMocks.liveSessions.mockResolvedValue(['det-1'])
    nativeMocks.detachedList.mockResolvedValue([{
      id: 'det-1', command: 'claude', cwd: '/repo', running: true, attach: 'current-attach-command',
    }])
    runHydration(context())
    await vi.waitFor(() => expect(useAppStore.getState().agents[0]?.status).toBe('running'))
    expect(nativeMocks.spawnSession).not.toHaveBeenCalled()
  })

  it('does not access Keychain while hydrating a satellite window', async () => {
    const ctx = context(false)
    runHydration(ctx)
    await vi.waitFor(() => expect(ctx.persistence.markReady).toHaveBeenCalled())
    expect(nativeMocks.secretGet).not.toHaveBeenCalled()
  })
})
