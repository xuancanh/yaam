// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSessionPromptActions } from './prompt-actions'
import type { PromptActionsCtx } from './prompt-actions'
import type { SessionProcessPort } from './ports'
import { useAppStore } from '../../core/store'
import type { MutableRefObject } from 'react'
import type { AppState, Agent } from '../../core/types'

const liveStateRef = { get current() { return useAppStore.getState() } } as MutableRefObject<AppState>

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Worker', kind: 'real', status: 'needs', log: [{ t: 'sys', x: 'x' }],
  ...over,
} as unknown as Agent)

function fakePort(over: Partial<SessionProcessPort> = {}): SessionProcessPort {
  return {
    isTauri: false,
    spawnSession: vi.fn(async () => {}), killSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}),
    writeSession: vi.fn(async () => {}), sendLine: vi.fn(), detectCliSession: vi.fn(async () => null),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    restoreTerminalModes: vi.fn(),
    quiesceTerminal: vi.fn(),
    resetTerminal: vi.fn(),
    attachTerminal: vi.fn(() => ({ writeln: vi.fn() })), disposeTerminal: vi.fn(), isAltScreen: vi.fn(() => false),
    ...over,
  }
}

function ctx(port: SessionProcessPort): PromptActionsCtx {
  return { stateRef: liveStateRef, flash: vi.fn(), logEvent: vi.fn(), armResponseWatch: vi.fn(), clearFlagged: vi.fn(), port }
}

const get = (id: string) => useAppStore.getState().agents.find(a => a.id === id)

beforeEach(() => {
  useAppStore.setState({
    agents: [agent()],
    messages: [{
      id: 'm1', kind: 'escalate', escFor: 'a1',
      esc: { resolved: false, cursorNum: 1, options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'No' }] },
    }] as unknown as AppState['messages'],
  } as Partial<AppState> as AppState)
})

describe('createSessionPromptActions', () => {
  it('answerPrompt navigates to the chosen option, submits, and resolves the card', () => {
    const port = fakePort()
    const c = ctx(port)
    createSessionPromptActions(c).answerPrompt('a1', 2)
    // one line down from cursorNum 1 to option 2, then Enter (deferred)
    expect(port.writeSession).toHaveBeenCalledWith('a1', '\x1b[B')
    expect(c.clearFlagged).toHaveBeenCalledWith('a1')
    expect(c.armResponseWatch).toHaveBeenCalledWith('a1')
    expect(get('a1')?.status).toBe('running')
    const esc = (useAppStore.getState().messages[0] as { esc?: { resolved: boolean; choice?: string } }).esc
    expect(esc).toMatchObject({ resolved: true, choice: '2. No' })
  })

  it('approve sends Enter to a real session and resolves as approved', () => {
    const port = fakePort()
    createSessionPromptActions(ctx(port)).approve('a1')
    expect(port.writeSession).toHaveBeenCalledWith('a1', '\r')
    expect(get('a1')?.status).toBe('running')
    const esc = (useAppStore.getState().messages[0] as { esc?: { decision?: string } }).esc
    expect(esc?.decision).toBe('approved')
  })

  it('deny sends Escape and resolves as denied', () => {
    const port = fakePort()
    createSessionPromptActions(ctx(port)).deny('a1')
    expect(port.writeSession).toHaveBeenCalledWith('a1', '\x1b')
    const esc = (useAppStore.getState().messages[0] as { esc?: { decision?: string } }).esc
    expect(esc?.decision).toBe('denied')
  })

  it('approve does not write to a chat agent (no PTY)', () => {
    useAppStore.setState({ agents: [agent({ kind: 'chat' })] } as Partial<AppState> as AppState)
    const port = fakePort()
    createSessionPromptActions(ctx(port)).approve('a1')
    expect(port.writeSession).not.toHaveBeenCalled()
  })
})
