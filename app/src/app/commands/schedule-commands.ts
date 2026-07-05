// Schedule domain commands. Toggling and removing a schedule are shared use
// cases for the schedules UI, Master, and addons — one validated, policy-checked
// definition (gated by the `schedules` capability) by cron id.
import type { StatePort } from '../../core/ports'
import type { CommandRegistry } from './registry'

export interface RemoveScheduleInput { id: string }
export interface ToggleScheduleInput { id: string; on?: boolean }

export function registerScheduleCommands(registry: CommandRegistry, state: StatePort): void {
  registry.register<RemoveScheduleInput, void>({
    name: 'remove_schedule',
    capability: 'schedules',
    validate: i => { if (!i.id) throw new Error('remove_schedule: id is required') },
    handler: i => state.update(s => ({ ...s, crons: s.crons.filter(c => c.id !== i.id) })),
  })

  registry.register<ToggleScheduleInput, void>({
    name: 'toggle_schedule',
    capability: 'schedules',
    validate: i => { if (!i.id) throw new Error('toggle_schedule: id is required') },
    // explicit `on` sets it; omitted flips the current value
    handler: i => state.update(s => ({ ...s, crons: s.crons.map(c => (c.id === i.id ? { ...c, on: i.on ?? !c.on } : c)) })),
  })
}
