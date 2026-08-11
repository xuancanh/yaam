import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { registerSessionCommands } from './session-commands'
import { createCommandRegistry } from './registry'
import type { SessionProcessPort } from '../../domains/session/ports'
import type { AppState, Agent } from '../../core/types'

function fakePort(over: Partial<SessionProcessPort> = {}): SessionProcessPort {
  return {
    isTauri: false,
    spawnSession: vi.fn(async () => {}), killSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}),
    writeSession: vi.fn(async () => {}), sendLine: vi.fn(), detectCliSession: vi.fn(async () => null), hooksInfo: vi.fn(async () => null), installKiroHooks: vi.fn(async () => {}), watchTranscript: vi.fn(async () => {}), unwatchTranscript: vi.fn(async () => {}), freePort: vi.fn(async () => null), watchOpencode: vi.fn(async () => {}), unwatchOpencode: vi.fn(async () => {}), acpStart: vi.fn(async () => {}), acpCancel: vi.fn(async () => {}), acpStop: vi.fn(async () => {}),
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
    ...over,
  }
}

function harness(agents: Agent[]) {
  const stateRef = { current: { agents } as unknown as AppState } as MutableRefObject<AppState>
  const port = fakePort()
  const markUserStopped = vi.fn()
  const promptAnswer = { current: { answerPrompt: vi.fn(), approve: vi.fn(), deny: vi.fn() } }
  const registry = createCommandRegistry(() => 'allow')
  registerSessionCommands(registry, { stateRef, markUserStopped, promptAnswer, port })
  return { registry, port, markUserStopped, promptAnswer }
}

const agent = (id: string): Agent => ({ id, name: id, kind: 'real', status: 'running', log: [] } as unknown as Agent)
const user = { actor: { kind: 'user' } as const }

describe('session commands', () => {
  it('send_to_session writes to a live session, ignores a dead one', async () => {
    const h = harness([agent('a1')])
    await h.registry.execute('send_to_session', { sessionId: 'a1', text: 'hi' }, user)
    expect(h.port.sendLine).toHaveBeenCalledWith('a1', 'hi')
    await h.registry.execute('send_to_session', { sessionId: 'gone', text: 'x' }, user)
    expect(h.port.sendLine).toHaveBeenCalledTimes(1) // dead session ignored
  })

  it('send_to_session rejects a missing sessionId (validation)', async () => {
    const h = harness([agent('a1')])
    await expect(h.registry.execute('send_to_session', { text: 'x' }, user)).rejects.toThrow(/sessionId/)
  })

  it('answer_permission_prompt routes to the prompt verbs and validates choice', async () => {
    const h = harness([agent('a1')])
    await h.registry.execute('answer_permission_prompt', { sessionId: 'a1', choice: 2 }, user)
    expect(h.promptAnswer.current.answerPrompt).toHaveBeenCalledWith('a1', 2)
    await h.registry.execute('answer_permission_prompt', { sessionId: 'a1', choice: 'approve' }, user)
    expect(h.promptAnswer.current.approve).toHaveBeenCalledWith('a1')
    await h.registry.execute('answer_permission_prompt', { sessionId: 'a1', choice: 'deny' }, user)
    expect(h.promptAnswer.current.deny).toHaveBeenCalledWith('a1')
    await expect(h.registry.execute('answer_permission_prompt', { sessionId: 'a1', choice: 0 }, user)).rejects.toThrow(/choice/)
    // dead sessions are ignored
    await h.registry.execute('answer_permission_prompt', { sessionId: 'gone', choice: 'approve' }, user)
    expect(h.promptAnswer.current.approve).toHaveBeenCalledTimes(1)
  })

  it('interrupt_turn cancels ACP turns and sends Escape to PTY sessions', async () => {
    const acp = { ...agent('a1'), acp: true } as Agent
    const h = harness([acp, agent('a2')])
    await h.registry.execute('interrupt_turn', { sessionId: 'a1' }, user)
    expect(h.port.acpCancel).toHaveBeenCalledWith('a1')
    await h.registry.execute('interrupt_turn', { sessionId: 'a2' }, user)
    expect(h.port.writeSession).toHaveBeenCalledWith('a2', '\x1b')
  })

  it('stop_session flags the stop then kills the session', async () => {
    const h = harness([agent('a1')])
    await h.registry.execute('stop_session', { sessionId: 'a1' }, user)
    expect(h.markUserStopped).toHaveBeenCalledWith('a1')
    expect(h.port.killSession).toHaveBeenCalledWith('a1')
  })

  it('stop_session is a no-op for an unknown session', async () => {
    const h = harness([agent('a1')])
    await h.registry.execute('stop_session', { sessionId: 'ghost' }, user)
    expect(h.markUserStopped).not.toHaveBeenCalled()
    expect(h.port.killSession).not.toHaveBeenCalled()
  })
})
