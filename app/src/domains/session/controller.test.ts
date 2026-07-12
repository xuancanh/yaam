// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createSessionController } from './controller'
import type { SessionControllerCtx } from './controller'
import type { SessionProcessPort } from './ports'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { AppState, Agent } from '../../core/types'

function fakePort(): SessionProcessPort {
  return {
    isTauri: false,
    spawnSession: vi.fn(async () => {}), killSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}),
    writeSession: vi.fn(async () => {}), sendLine: vi.fn(), detectCliSession: vi.fn(async () => null),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    sandboxWrapper: vi.fn(async () => "sandbox-exec -f '/fake.sb'"),
    detachedSpawn: vi.fn(async () => 'attach-cmd'),
    detachedKill: vi.fn(async () => {}),
    restoreTerminalModes: vi.fn(),
    quiesceTerminal: vi.fn(),
    repaintTerminal: vi.fn(),
    terminalSize: vi.fn(() => ({ rows: 48, cols: 190 })),
    resetTerminal: vi.fn(),
    attachTerminal: vi.fn(() => ({ writeln: vi.fn() })), disposeTerminal: vi.fn(), isAltScreen: vi.fn(() => false),
  }
}

function ctx(port: SessionProcessPort): SessionControllerCtx {
  return {
    stateRef: { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>,
    flash: vi.fn(), logEvent: vi.fn(), markUserStopped: vi.fn(), disposeSessionRuntime: vi.fn(),
    launchSession: vi.fn(() => 'id'), probeCliSession: vi.fn(), armResponseWatch: vi.fn(),
    appendTail: vi.fn(), clearNeeds: vi.fn(), bumpSettle: vi.fn(), clearFlagged: vi.fn(), port,
  }
}

describe('createSessionController', () => {
  it('exposes the whole session lifecycle: process actions + prompt answers', () => {
    const c = createSessionController(ctx(fakePort()))
    for (const m of ['archiveSession', 'unarchiveSession', 'deleteSession', 'resume', 'newRealSession', 'sendInput', 'stopSession', 'answerPrompt', 'approve', 'deny'] as const) {
      expect(c[m]).toBeTypeOf('function')
    }
  })

  it('drives both process actions and prompt answers through the one injected port', () => {
    const port = fakePort()
    useAppStore.setState({ agents: [{ id: 'a1', name: 'W', kind: 'real', status: 'running', log: [] } as unknown as Agent] } as Partial<AppState> as AppState)
    const c = createSessionController(ctx(port))
    c.stopSession('a1')
    c.approve('a1')
    expect(port.killSession).toHaveBeenCalledWith('a1') // process action
    expect(port.writeSession).toHaveBeenCalledWith('a1', '\r') // prompt answer
  })
})
