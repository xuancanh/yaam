// Board domain commands on the application command registry. Creating a task is
// the same use case for the board UI, Master, and addons — this makes it one
// validated, policy-checked definition (gated by the `tasks` capability) instead
// of three ad-hoc dispatches. `add_task` accepts a caller-minted id so a caller
// that needs the id can supply + return it over the fire-and-forget seam.
import type { BoardCol } from '../../core/types'
import { mkId } from '../../shared/id'
import type { StatePort } from '../../core/ports'
import type { CommandRegistry } from './registry'

export interface AddTaskInput {
  /** caller-minted id (so a caller can return it); generated when omitted */
  id?: string
  title: string
  col?: string
  /** the creation chat note (defaults to "Task created") */
  note?: string
  description?: string
  criteria?: string[]
  cwd?: string
  typeId?: string
  templateId?: string
}

const COLS: BoardCol[] = ['backlog', 'progress', 'review', 'done', 'failed']

export function registerBoardCommands(registry: CommandRegistry, state: StatePort): void {
  registry.register<AddTaskInput, string>({
    name: 'add_task',
    capability: 'tasks',
    validate: i => { if (!i.title?.trim()) throw new Error('add_task: title is required') },
    handler: i => {
      const id = i.id ?? mkId('t')
      const col = i.col && (COLS as string[]).includes(i.col) ? (i.col as BoardCol) : 'backlog'
      state.update(s => ({
        ...s,
        tasks: s.tasks.concat([{
          id,
          title: i.title.trim().slice(0, 120),
          col,
          agentId: null,
          description: i.description?.trim() || undefined,
          criteria: (i.criteria ?? []).map(c => c.trim()).filter(Boolean),
          cwd: i.cwd?.trim() || undefined,
          typeId: i.typeId || undefined,
          templateId: i.templateId || undefined,
          chat: [{ id: mkId('tc'), role: 'system', text: i.note || 'Task created', at: Date.now() }],
        }]),
      }))
      return id
    },
  })
}
