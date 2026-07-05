import { describe, expect, it } from 'vitest'
import { registerScheduleCommands } from './schedule-commands'
import { createCommandRegistry } from './registry'
import { createFakeStatePort } from '../../core/ports.fakes'
import type { AppState, Cron } from '../../core/types'

function harness(crons: Cron[]) {
  const state = createFakeStatePort({ crons } as unknown as AppState)
  const registry = createCommandRegistry(() => 'allow')
  registerScheduleCommands(registry, state)
  return { registry, state }
}
const user = { actor: { kind: 'user' } as const }
const cron = (id: string, on: boolean): Cron => ({ id, name: id, on } as unknown as Cron)

describe('schedule commands', () => {
  it('toggle_schedule flips on/off, or sets an explicit value', async () => {
    const h = harness([cron('c1', true)])
    await h.registry.execute('toggle_schedule', { id: 'c1' }, user)
    expect(h.state.get().crons[0].on).toBe(false)
    await h.registry.execute('toggle_schedule', { id: 'c1', on: true }, user)
    expect(h.state.get().crons[0].on).toBe(true)
  })

  it('remove_schedule deletes by id', async () => {
    const h = harness([cron('c1', true), cron('c2', false)])
    await h.registry.execute('remove_schedule', { id: 'c1' }, user)
    expect(h.state.get().crons.map(c => c.id)).toEqual(['c2'])
  })

  it('validates a missing id', async () => {
    const h = harness([cron('c1', true)])
    await expect(h.registry.execute('toggle_schedule', {}, user)).rejects.toThrow(/id/)
    await expect(h.registry.execute('remove_schedule', {}, user)).rejects.toThrow(/id/)
  })
})
