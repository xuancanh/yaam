import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionActions } from './actions'
import type { SessionActionsCtx } from './actions'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { Agent, AppState } from '../../core/types'

vi.mock('../../core/native', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  worktreeMerge: vi.fn(async () => [{ name: 'repo', status: 'merged', detail: '2 commit(s) merged' }]),
  worktreeRemove: vi.fn(async () => {}),
}))
import { worktreeMerge, worktreeRemove } from '../../core/native'

const liveStateRef = { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Iso Worker', short: 'IW', color: '#fff', repo: 'repo', branch: 'live',
  status: 'idle', model: 'mycli', kind: 'real', cwd: '/wt/repo',
  worktree: { root: '/wt', base: '/repo', workdir: '/wt/repo' },
  log: [], memory: [], tools: [],
  ...over,
} as unknown as Agent)

function ctx(over: Partial<SessionActionsCtx> = {}): SessionActionsCtx {
  return {
    stateRef: liveStateRef,
    flash: vi.fn(),
    logEvent: vi.fn(),
    markUserStopped: vi.fn(),
    disposeSessionRuntime: vi.fn(),
    launchSession: vi.fn(() => null),
    probeCliSession: vi.fn(),
    armResponseWatch: vi.fn(),
    appendTail: vi.fn(),
    clearNeeds: vi.fn(),
    bumpSettle: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    agents: [agent()], tasks: [], activeWorkspace: 'ws',
  } as Partial<AppState> as AppState)
})

describe('mergeSessionWorktree', () => {
  it('merges, removes the mirror, clears the agent worktree, and logs the summary', async () => {
    const c = ctx()
    const err = await createSessionActions(c).mergeSessionWorktree('a1')
    expect(err).toBe('')
    expect(worktreeMerge).toHaveBeenCalledWith('/wt', expect.stringContaining('Iso Worker'))
    expect(worktreeRemove).toHaveBeenCalledWith('/wt')
    const a = useAppStore.getState().agents.find(x => x.id === 'a1')!
    expect(a.worktree).toBeUndefined()
    expect(a.cwd).toBe('/repo')
    expect(a.log.some(l => l.t === 'sys' && l.x.includes('merged back'))).toBe(true)
    expect(c.logEvent).toHaveBeenCalledWith('done', 'a1', expect.stringContaining('Iso Worker'))
  })

  it('surfaces per-repo failures and keeps the worktree for another attempt', async () => {
    vi.mocked(worktreeMerge).mockResolvedValueOnce([
      { name: 'repo', status: 'error', detail: 'merge conflict — aborted' },
    ])
    const err = await createSessionActions(ctx()).mergeSessionWorktree('a1')
    expect(err).toContain('merge conflict')
    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(useAppStore.getState().agents.find(x => x.id === 'a1')?.worktree).toBeDefined()
  })

  it('reports sessions that have no worktree without touching git', async () => {
    useAppStore.setState({ agents: [agent({ worktree: undefined })] } as Partial<AppState> as AppState)
    const err = await createSessionActions(ctx()).mergeSessionWorktree('a1')
    expect(err).toContain('no worktree')
    expect(worktreeMerge).not.toHaveBeenCalled()
  })

  it('keeps the worktree recoverable when cleanup fails after merging', async () => {
    vi.mocked(worktreeRemove).mockRejectedValueOnce(new Error('directory busy'))
    const err = await createSessionActions(ctx()).mergeSessionWorktree('a1')
    expect(err).toContain('cleanup failed')
    expect(useAppStore.getState().agents.find(x => x.id === 'a1')).toMatchObject({
      cwd: '/wt/repo', worktree: { root: '/wt' },
    })
  })

  it('refuses to remove a worktree while its session is live', async () => {
    useAppStore.setState({ agents: [agent({ status: 'running' })] } as Partial<AppState> as AppState)
    const actions = createSessionActions(ctx())
    await expect(actions.mergeSessionWorktree('a1')).resolves.toContain('stop the session')
    await expect(actions.discardSessionWorktree('a1')).resolves.toContain('stop the session')
    expect(worktreeMerge).not.toHaveBeenCalled()
    expect(worktreeRemove).not.toHaveBeenCalled()
  })

  it('discard restores the original working folder after cleanup', async () => {
    const err = await createSessionActions(ctx()).discardSessionWorktree('a1')
    expect(err).toBe('')
    expect(useAppStore.getState().agents.find(x => x.id === 'a1')).toMatchObject({ cwd: '/repo', worktree: undefined })
  })
})
