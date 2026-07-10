import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardActions } from './actions'
import type { BoardActionsCtx } from './actions'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { Agent, AppState, BoardTask } from '../../core/types'

vi.mock('../../core/native', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  worktreeMerge: vi.fn(async () => [{ name: 'repo', status: 'merged', detail: '1 commit(s) merged' }]),
  worktreeRemove: vi.fn(async () => {}),
}))
import { worktreeMerge, worktreeRemove } from '../../core/native'

const liveStateRef = { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>

const task = (over: Partial<BoardTask> = {}): BoardTask => ({
  id: 't1', title: 'Fix the login flow', col: 'review', agentId: 'a1', agentIds: ['a1'], ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Worker', short: 'WO', color: '#fff', repo: 'repo', branch: 'live',
  status: 'idle', model: 'mycli', kind: 'real', cwd: '/wt/repo',
  worktree: { root: '/wt', base: '/repo', workdir: '/wt/repo' },
  log: [], memory: [], tools: [],
  ...over,
} as unknown as Agent)

function ctx(over: Partial<BoardActionsCtx> = {}): BoardActionsCtx {
  return {
    dispatch: f => useAppStore.setState(f(useAppStore.getState())),
    stateRef: liveStateRef,
    dragId: { current: null },
    later: vi.fn(),
    flash: vi.fn(),
    logEvent: vi.fn(),
    fireAddonHook: vi.fn(),
    spawnSessionForTask: vi.fn(),
    startTaskViaWatcher: vi.fn(),
    runWatcher: vi.fn(),
    pushTaskChat: vi.fn(),
    markUserStopped: vi.fn(),
    disposeWatcher: vi.fn(),
    taskSessions: { current: new Map([['a1', { taskId: 't1', workspaceId: 'ws' }]]) },
    ...over,
  }
}

function seed(tasks: BoardTask[], agents: Agent[] = []) {
  useAppStore.setState({
    tasks, agents, activeWorkspace: 'ws', workspaceData: {}, drawer: null,
  } as Partial<AppState> as AppState)
}

const getTask = (id: string) => useAppStore.getState().tasks.find(t => t.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  seed([task()], [agent()])
})

describe('archive / restore / delete', () => {
  it('archiveTask hides the task recoverably: watcher disposed, session binding dropped', () => {
    const c = ctx()
    createBoardActions(c).archiveTask('t1')
    expect(getTask('t1')).toMatchObject({ archived: true, awaitingUser: false })
    expect(c.disposeWatcher).toHaveBeenCalledWith('t1')
    expect(c.taskSessions.current.has('a1')).toBe(false)
  })

  it('restoreTask brings an archived task back to its column', () => {
    seed([task({ archived: true, col: 'progress' })])
    createBoardActions(ctx()).restoreTask('t1')
    expect(getTask('t1')).toMatchObject({ archived: false, col: 'progress' })
  })

  it('deleteTask (Archived viewer only) removes the task outright', () => {
    const c = ctx()
    createBoardActions(c).deleteTask('t1')
    expect(getTask('t1')).toBeUndefined()
    expect(c.disposeWatcher).toHaveBeenCalledWith('t1')
  })
})

describe('review queue actions', () => {
  it('approveTaskReview merges the worktree back, cleans up, and moves the task to done', async () => {
    const c = ctx()
    const err = await createBoardActions(c).approveTaskReview('t1')
    expect(err).toBe('')
    expect(worktreeMerge).toHaveBeenCalledWith('/wt', expect.stringContaining('Fix the login flow'))
    expect(worktreeRemove).toHaveBeenCalledWith('/wt')
    expect(getTask('t1')?.col).toBe('done')
    // the removed mirror must not be re-entered by follow-up sessions
    expect(useAppStore.getState().agents.find(a => a.id === 'a1')).toMatchObject({ cwd: '/repo', worktree: undefined })
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('merged back'))
  })

  it('approveTaskReview keeps the task in review when a repo merge fails', async () => {
    vi.mocked(worktreeMerge).mockResolvedValueOnce([
      { name: 'app', status: 'merged', detail: '' },
      { name: 'api', status: 'error', detail: 'merge conflict — aborted' },
    ])
    const c = ctx()
    const err = await createBoardActions(c).approveTaskReview('t1')
    expect(err).toContain('api: error')
    expect(worktreeRemove).not.toHaveBeenCalled()
    expect(getTask('t1')?.col).toBe('review')
  })

  it('keeps the task and worktree recoverable when cleanup fails', async () => {
    vi.mocked(worktreeRemove).mockRejectedValueOnce(new Error('directory busy'))
    const err = await createBoardActions(ctx()).approveTaskReview('t1')
    expect(err).toContain('cleanup failed')
    expect(getTask('t1')?.col).toBe('review')
    expect(useAppStore.getState().agents.find(a => a.id === 'a1')).toMatchObject({ cwd: '/wt/repo', worktree: { root: '/wt' } })
  })

  it('refuses review cleanup while a task session is live', async () => {
    seed([task()], [agent({ status: 'running' })])
    const err = await createBoardActions(ctx()).approveTaskReview('t1')
    expect(err).toContain('stop session')
    expect(worktreeMerge).not.toHaveBeenCalled()
    expect(getTask('t1')?.col).toBe('review')
  })

  it('approveTaskReview without a worktree just moves the task to done', async () => {
    seed([task()], [agent({ worktree: undefined })])
    const err = await createBoardActions(ctx()).approveTaskReview('t1')
    expect(err).toBe('')
    expect(worktreeMerge).not.toHaveBeenCalled()
    expect(getTask('t1')?.col).toBe('done')
  })

  it('rejectTaskReview bounces the task to progress and briefs the watcher with the comment', () => {
    const c = ctx()
    createBoardActions(c).rejectTaskReview('t1', 'error handling is wrong in api.ts')
    expect(getTask('t1')?.col).toBe('progress')
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'user', expect.stringContaining('error handling is wrong'))
    expect(c.runWatcher).toHaveBeenCalledWith('t1', expect.stringContaining('error handling is wrong'))
  })
})
