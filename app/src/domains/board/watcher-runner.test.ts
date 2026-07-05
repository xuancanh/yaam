import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type { AppState, BoardTask } from '../../core/types'
import type { ApiMessage } from '../../llm/client'
import { AbortRegistry } from '../../core/abort-registry'

let creds = true
vi.mock('../../master', () => ({ buildCfg: () => ({}), hasCreds: () => creds }))
vi.mock('../../core/terminals', () => ({ isAltScreen: () => false, readScreen: () => '' }))

const turn = vi.fn(async (): Promise<string> => 'watcher reply')
vi.mock('./watcher', () => ({ runWatcherTurn: (...a: unknown[]) => turn(...(a as [])) }))

import { runWatcherLoop } from './watcher-runner'
import type { WatcherCtx } from './watcher-runner'
import { runWatcherTurn } from './watcher'

const task = (id: string): BoardTask => ({ id, title: id, col: 'progress', agentId: null } as BoardTask)

function ctx(over: Partial<WatcherCtx> = {}): WatcherCtx {
  const state = { settings: { masterEnabled: true }, activeWorkspace: 'ws', tasks: [task('t1')], workspaceData: {}, agents: [] } as unknown as AppState
  return {
    stateRef: { current: state } as MutableRefObject<AppState>,
    dispatch: vi.fn(),
    histories: new Map<string, ApiMessage[]>(),
    busy: new Set<string>(),
    queue: new Map<string, string[]>(),
    aborts: new AbortRegistry(),
    taskSessions: { current: new Map() } as MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>,
    applyAgentStatus: vi.fn(),
    pushTaskChat: vi.fn(),
    logEvent: vi.fn(),
    notify: vi.fn(),
    fireAddonHook: vi.fn(),
    spawnTaskSession: vi.fn(() => null),
    ...over,
  }
}

beforeEach(() => {
  creds = true
  turn.mockReset()
  turn.mockResolvedValue('watcher reply')
})

describe('runWatcherLoop failure surfacing (a silent watcher reads as a broken chat)', () => {
  it('tells the user in the task chat when no brain/credentials are configured', async () => {
    creds = false
    const c = ctx()
    await runWatcherLoop(c, 't1', '[user message] hello?')
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('Master Brain'))
    expect(turn).not.toHaveBeenCalled()
  })

  it('stays quiet for automated notes when no brain is configured (no spam)', async () => {
    creds = false
    const c = ctx()
    await runWatcherLoop(c, 't1', 'session exited cleanly')
    expect(c.pushTaskChat).not.toHaveBeenCalled()
  })

  it('posts the watcher error into the task chat instead of only the activity feed', async () => {
    turn.mockRejectedValueOnce(new Error('messages.2: unexpected tool_use_id'))
    const c = ctx()
    await runWatcherLoop(c, 't1', '[user message] status?')
    expect(c.logEvent).toHaveBeenCalledWith('escalate', null, expect.stringContaining('unexpected tool_use_id'))
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('Watcher error'))
  })

  it('acknowledges a user message even when the turn produced no prose reply', async () => {
    turn.mockResolvedValueOnce('')
    const c = ctx()
    await runWatcherLoop(c, 't1', '[user message] do it')
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'system', expect.stringContaining('no reply'))
  })

  it('posts the reply normally when the turn succeeds', async () => {
    const c = ctx()
    await runWatcherLoop(c, 't1', '[user message] status?')
    expect(c.pushTaskChat).toHaveBeenCalledWith('t1', 'watcher', 'watcher reply')
  })
})

// silence the unused-import lint: the mock above replaces the real module
void runWatcherTurn
