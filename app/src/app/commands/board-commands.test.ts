import { describe, expect, it, vi } from 'vitest'
import { registerBoardCommands } from './board-commands'
import { createCommandRegistry } from './registry'
import { createFakeStatePort } from '../../core/ports.fakes'
import type { AppState, BoardTask } from '../../core/types'

function harness(tasks: BoardTask[] = []) {
  const state = createFakeStatePort({ tasks } as unknown as AppState)
  const registry = createCommandRegistry(() => 'allow')
  const fireAddonHook = vi.fn()
  registerBoardCommands(registry, state, fireAddonHook)
  return { registry, state, fireAddonHook }
}
const user = { actor: { kind: 'user' } as const }

describe('board commands', () => {
  it('add_task creates a task and returns its id', async () => {
    const h = harness()
    const id = await h.registry.execute<string>('add_task', { title: '  Build the thing  ', criteria: [' a ', '', 'b'] }, user)
    const t = h.state.get().tasks[0]
    expect(t.id).toBe(id)
    expect(t.title).toBe('Build the thing')       // trimmed
    expect(t.col).toBe('backlog')                  // default column
    expect(t.criteria).toEqual(['a', 'b'])         // trimmed + empties dropped
    expect(t.chat?.[0].text).toBe('Task created')  // default note
  })

  it('add_task honors a caller-minted id, chosen column, and note', async () => {
    const h = harness()
    await h.registry.execute('add_task', { id: 'given-1', title: 'x', col: 'review', note: 'via addon' }, user)
    const t = h.state.get().tasks[0]
    expect(t.id).toBe('given-1')
    expect(t.col).toBe('review')
    expect(t.chat?.[0].text).toBe('via addon')
  })

  it('add_task rejects an empty title and falls back to backlog for a bad column', async () => {
    const h = harness()
    await expect(h.registry.execute('add_task', { title: '  ' }, user)).rejects.toThrow(/title/)
    await h.registry.execute('add_task', { title: 't', col: 'nonsense' }, user)
    expect(h.state.get().tasks[0].col).toBe('backlog')
  })

  it('remove_task deletes by id', async () => {
    const h = harness([{ id: 't1', title: 'a', col: 'backlog', agentId: null }, { id: 't2', title: 'b', col: 'backlog', agentId: null }] as BoardTask[])
    await h.registry.execute('remove_task', { id: 't1' }, user)
    expect(h.state.get().tasks.map(t => t.id)).toEqual(['t2'])
  })

  it('move_task changes the column and fires onTaskMoved once (only on a real change)', async () => {
    const h = harness([{ id: 't1', title: 'Ship it', col: 'backlog', agentId: null }] as BoardTask[])
    await h.registry.execute('move_task', { id: 't1', col: 'review' }, user)
    expect(h.state.get().tasks[0].col).toBe('review')
    expect(h.fireAddonHook).toHaveBeenCalledWith('onTaskMoved', { taskId: 't1', title: 'Ship it', col: 'review', from: 'backlog' })

    // same-column move is a no-op (no second hook), and an invalid column is ignored
    await h.registry.execute('move_task', { id: 't1', col: 'review' }, user)
    await h.registry.execute('move_task', { id: 't1', col: 'nonsense' }, user)
    expect(h.fireAddonHook).toHaveBeenCalledTimes(1)
    expect(h.state.get().tasks[0].col).toBe('review')
  })
})
