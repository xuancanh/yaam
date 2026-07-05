import { describe, expect, it, vi } from 'vitest'
import { registerBoardCommands } from './board-commands'
import { createCommandRegistry } from './registry'
import { createDefaultPolicy } from './policy'
import { CommandDenied, type Actor } from './types'
import { createFakeStatePort } from '../../core/ports.fakes'
import type { AppState } from '../../core/types'

// The point of the command layer is that every caller reaches one handler
// through one policy gate. These tests drive the SAME command as each actor
// (UI/Master/watcher/chat/addon) and assert identical domain effects — the
// regression these guard against is a caller re-implementing an operation and
// drifting in validation or behavior.
function harness() {
  const state = createFakeStatePort({ tasks: [] } as unknown as AppState)
  // 'granted' holds the tasks capability; 'blocked' holds none.
  const policy = createDefaultPolicy(id => (id === 'granted' ? ['tasks'] : []))
  const registry = createCommandRegistry(policy)
  registerBoardCommands(registry, state, vi.fn())
  return { registry, state }
}

const trustedActors: Actor[] = [
  { kind: 'user' },
  { kind: 'master' },
  { kind: 'watcher', taskId: 't' },
  { kind: 'chat', sessionId: 's' },
]

describe('command parity across callers', () => {
  it.each(trustedActors)('add_task via $kind produces the same task', async actor => {
    const h = harness()
    await h.registry.execute('add_task', { title: 'Ship it', col: 'review' }, { actor })
    const t = h.state.get().tasks[0]
    expect({ title: t.title, col: t.col }).toEqual({ title: 'Ship it', col: 'review' })
  })

  it('a granted addon reaches the identical handler', async () => {
    const h = harness()
    await h.registry.execute('add_task', { title: 'Ship it', col: 'review' }, { actor: { kind: 'addon', addonId: 'granted' } })
    const t = h.state.get().tasks[0]
    expect({ title: t.title, col: t.col }).toEqual({ title: 'Ship it', col: 'review' })
  })

  it('the shared policy gate denies an ungranted addon on the same path — no state change', async () => {
    const h = harness()
    await expect(
      h.registry.execute('add_task', { title: 'Ship it' }, { actor: { kind: 'addon', addonId: 'blocked' } }),
    ).rejects.toBeInstanceOf(CommandDenied)
    expect(h.state.get().tasks).toHaveLength(0)
  })
})
