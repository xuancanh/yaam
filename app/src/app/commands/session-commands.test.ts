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
    writeSession: vi.fn(async () => {}), sendLine: vi.fn(), detectCliSession: vi.fn(async () => null),
    createWorktree: vi.fn(async () => { throw new Error('no worktrees in tests') }),
    attachTerminal: vi.fn(() => ({ writeln: vi.fn() })), disposeTerminal: vi.fn(),
    ...over,
  }
}

function harness(agents: Agent[]) {
  const stateRef = { current: { agents } as unknown as AppState } as MutableRefObject<AppState>
  const port = fakePort()
  const markUserStopped = vi.fn()
  const registry = createCommandRegistry(() => 'allow')
  registerSessionCommands(registry, { stateRef, markUserStopped, port })
  return { registry, port, markUserStopped }
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
