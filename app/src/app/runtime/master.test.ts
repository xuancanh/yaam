// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  masterRun: vi.fn(),
  masterAbort: vi.fn(),
  schedulerStart: vi.fn(),
  schedulerDispose: vi.fn(),
}))

vi.mock('../../core/native', () => ({ isTauri: false }))
vi.mock('../../core/focus-session', () => ({ isUserWatching: () => false }))
vi.mock('../../domains/chat/actions', () => ({ buildChatSession: vi.fn() }))
vi.mock('../../domains/master/master-runtime', () => ({
  createMasterRuntime: vi.fn(() => ({ run: mocks.masterRun, abort: mocks.masterAbort })),
}))
vi.mock('../../domains/schedules/runtime', () => ({
  createSchedulerRuntime: vi.fn(() => ({ start: mocks.schedulerStart, dispose: mocks.schedulerDispose })),
}))

import { createMasterSubsystem } from './master'
import { createRuntimeRefs } from './refs'
import type { ConductorKernel } from '../conductor-runtime'
import type { SessionRuntime } from './session'
import type { AddonSubsystem } from './addon'
import type { WindowRole } from '../../core/window-role'
type AppState = import('../../core/types').AppState

function kernel(over: Partial<AppState> = {}): ConductorKernel {
  const state = { activeWorkspace: 'ws-a', workspaceData: {}, ...over } as unknown as AppState
  return {
    stateRef: { current: state },
    dragId: { current: null },
    later: () => {},
    flash: () => {},
    widOf: () => 'ws-a',
    logEvent: () => {},
    notify: () => {},
  }
}

const session = {} as SessionRuntime
const addon = {} as AddonSubsystem

describe('createMasterSubsystem window-role gating', () => {
  beforeEach(() => vi.clearAllMocks())

  it('main window: masterEvent runs Master for the active workspace', () => {
    const refs = createRuntimeRefs()
    createMasterSubsystem(kernel(), refs, session, addon)
    refs.masterEventRef.current('session needs input')
    expect(mocks.masterRun).toHaveBeenCalledTimes(1)
    expect(mocks.masterRun).toHaveBeenCalledWith('session needs input')
  })

  it('main window: the exposed runMaster drives the Master runtime', () => {
    const refs = createRuntimeRefs()
    const sub = createMasterSubsystem(kernel(), refs, session, addon)
    sub.runMaster('manual run')
    expect(mocks.masterRun).toHaveBeenCalledTimes(1)
    expect(mocks.masterRun).toHaveBeenCalledWith('manual run')
  })

  it('satellite: runMaster is an explicit no-op regardless of credentials', () => {
    const refs = createRuntimeRefs()
    const role: WindowRole = { kind: 'workspace', workspaceId: 'ws-a' }
    const sub = createMasterSubsystem(kernel(), refs, session, addon, undefined, undefined, undefined, role)
    sub.runMaster('manual run')
    expect(mocks.masterRun).not.toHaveBeenCalled()
  })

  it('satellite: masterEvent (monitor escalation) never reaches Master', () => {
    const refs = createRuntimeRefs()
    const role: WindowRole = { kind: 'workspace', workspaceId: 'ws-a' }
    createMasterSubsystem(kernel(), refs, session, addon, undefined, undefined, undefined, role)
    refs.masterEventRef.current('session needs input', 'agent-1')
    expect(mocks.masterRun).not.toHaveBeenCalled()
  })
})
