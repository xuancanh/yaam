import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type { Agent, AppState } from '../../core/types'

vi.mock('../../master', () => ({ buildCfg: () => ({}), hasCreds: () => true }))
vi.mock('../../core/terminals', () => ({ isAltScreen: () => false, readScreen: () => [] }))

let releaseFirst: (() => void) | undefined
const notes: string[] = []
const runMonitorTurn = vi.fn(async (_cfg: unknown, _agent: unknown, note: string) => {
  notes.push(note)
  if (notes.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
})
vi.mock('../../monitor', () => ({ runMonitorTurn: (...args: unknown[]) => runMonitorTurn(...(args as [unknown, unknown, string])) }))

import { createMonitorRuntime } from './monitor-runtime'

const agent = { id: 'a1', name: 'Worker', status: 'running', workspaceId: 'ws', log: [] } as unknown as Agent

function runtime() {
  const state = {
    settings: { masterEnabled: true, followMode: true }, agents: [agent], activeWorkspace: 'ws',
    assistantMemory: {}, harnessLog: [],
  } as unknown as AppState
  return createMonitorRuntime({
    stateRef: { current: state } as MutableRefObject<AppState>, dispatch: vi.fn(),
    applyAgentStatus: vi.fn(), setNeedsInput: vi.fn(), logEvent: vi.fn(), notify: vi.fn(), masterEvent: vi.fn(),
  })
}

beforeEach(() => {
  notes.length = 0
  releaseFirst = undefined
  runMonitorTurn.mockClear()
})

describe('monitor runtime queue', () => {
  it('retains submitted input and following output while a turn is busy', async () => {
    const rt = runtime()
    rt.run('a1', '[user terminal input] npm test')
    await vi.waitFor(() => expect(runMonitorTurn).toHaveBeenCalledTimes(1))

    rt.run('a1', '[progress] compiling tests')
    rt.run('a1', '[progress] 42 tests passed')
    releaseFirst?.()

    await vi.waitFor(() => expect(runMonitorTurn).toHaveBeenCalledTimes(2))
    expect(notes[1]).toContain('[progress] compiling tests')
    expect(notes[1]).toContain('[progress] 42 tests passed')
    expect(notes[1].indexOf('compiling tests')).toBeLessThan(notes[1].indexOf('42 tests passed'))
    rt.dispose('a1')
  })
})
