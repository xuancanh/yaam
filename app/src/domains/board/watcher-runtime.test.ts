// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { MutableRefObject } from 'react'
import type { AppState, BoardTask } from '../../core/types'

// Master config is trivially satisfied; the LLM turn is faked so we can control
// exactly when (and whether) it settles.
vi.mock('../../master', () => ({ buildCfg: () => ({}), hasCreds: () => true }))
vi.mock('../../core/terminals', () => ({ isAltScreen: () => false, readScreen: () => '' }))

let capturedSignal: AbortSignal | undefined
const runWatcherTurn = vi.fn((_cfg: unknown, _gt: unknown, _ga: unknown, _cur: unknown, _hist: unknown, _exec: unknown, signal: AbortSignal) =>
  // never resolves on its own — only rejects (as a real aborted fetch would)
  // once the per-task signal is aborted, so the loop's abort path is exercised
  new Promise((_resolve, reject) => {
    capturedSignal = signal
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal.aborted) fail()
    else signal.addEventListener('abort', fail)
  }))
vi.mock('./watcher', () => ({ runWatcherTurn: (...a: unknown[]) => runWatcherTurn(...(a as Parameters<typeof runWatcherTurn>)) }))

import { createWatcherRuntime } from './watcher-runtime'

const task = (id: string): BoardTask => ({ id, title: id, col: 'progress', agentId: null } as BoardTask)

function makeRuntime() {
  const state = { settings: { masterEnabled: true }, activeWorkspace: 'ws', tasks: [task('t1')], workspaceData: {}, agents: [] } as unknown as AppState
  return createWatcherRuntime({
    stateRef: { current: state } as MutableRefObject<AppState>,
    dispatch: vi.fn(), taskSessions: { current: new Map() } as MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>,
    applyAgentStatus: vi.fn(), pushTaskChat: vi.fn(), logEvent: vi.fn(), notify: vi.fn(),
    fireAddonHook: vi.fn(), spawnTaskSession: vi.fn(() => null),
  })
}

beforeEach(() => { runWatcherTurn.mockClear(); capturedSignal = undefined })

describe('watcher runtime cancellation', () => {
  it('dispose(taskId) aborts the in-flight turn and the loop exits cleanly', async () => {
    const rt = makeRuntime()
    const p = rt.run('t1', 'assess the task')
    await Promise.resolve() // let the loop reach the awaited turn
    expect(runWatcherTurn).toHaveBeenCalledOnce()
    expect(capturedSignal?.aborted).toBe(false)

    rt.dispose('t1') // task deleted → cancel its running LLM request

    await p // the loop must unwind rather than hang
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('releases the busy lock on dispose so a later run starts a fresh turn (not queued)', async () => {
    const rt = makeRuntime()
    const p1 = rt.run('t1', 'first')
    await Promise.resolve()
    rt.dispose('t1')
    await p1

    // a fresh run after teardown must actually start a new turn
    const p2 = rt.run('t1', 'second')
    await Promise.resolve()
    expect(runWatcherTurn).toHaveBeenCalledTimes(2)
    rt.dispose('t1')
    await p2
  })
})
