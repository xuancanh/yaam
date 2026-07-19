// Board domain commands on the application command registry. Creating a task is
// the same use case for the board UI, Master, and addons — this makes it one
// validated, policy-checked definition (gated by the `tasks` capability) instead
// of three ad-hoc dispatches. `add_task` accepts a caller-minted id so a caller
// that needs the id can supply + return it over the fire-and-forget seam.
import type { BoardCol } from '../../core/types'
import { mkId } from '../../shared/id'
import { createHistoryEntry, prependHistory } from '../../core/history'
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
  machineId?: string
  isolate?: boolean
  sessionMode?: 'oneshot' | 'interactive'
  /** epoch ms — the scheduler spawns the task's session at this time */
  scheduleAt?: number
}

export interface RemoveTaskInput { id: string }
export interface MoveTaskInput { id: string; col: string }

const COLS: BoardCol[] = ['backlog', 'progress', 'review', 'done', 'failed']

export function registerBoardCommands(
  registry: CommandRegistry,
  state: StatePort,
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void,
): void {
  registry.register<AddTaskInput, string>({
    name: 'add_task',
    capability: 'tasks',
    validate: i => { if (!i.title?.trim()) throw new Error('add_task: title is required') },
    handler: (i, ctx) => {
      const id = i.id ?? mkId('t')
      const col = i.col && (COLS as string[]).includes(i.col) ? (i.col as BoardCol) : 'backlog'
      const createdAt = Date.now()
      const chatId = mkId('tc')
      const scheduleAt = typeof i.scheduleAt === 'number' && i.scheduleAt > createdAt ? i.scheduleAt : undefined
      const actor = ctx.actor.kind === 'user' ? 'user' : ctx.actor.kind === 'watcher' ? 'watcher' : 'system'
      const created = createHistoryEntry({
        category: 'lifecycle', actor, kind: 'create',
        text: `Created task · ${i.title.trim().slice(0, 60)}`,
        taskId: id, taskTitle: i.title.trim().slice(0, 120),
      })
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
          machineId: i.machineId || undefined,
          isolate: i.isolate || undefined,
          sessionMode: i.sessionMode === 'interactive' ? 'interactive' : undefined,
          scheduleAt,
          chat: [{ id: chatId, role: 'system', text: i.note || 'Task created', at: createdAt }],
          history: [created],
        }]),
      }))
      return id
    },
  })

  registry.register<RemoveTaskInput, void>({
    name: 'remove_task',
    capability: 'tasks',
    validate: i => { if (!i.id) throw new Error('remove_task: id is required') },
    handler: i => state.update(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== i.id) })),
  })

  registry.register<MoveTaskInput, void>({
    name: 'move_task',
    capability: 'tasks',
    validate: i => { if (!i.id) throw new Error('move_task: id is required') },
    handler: (i, ctx) => {
      // invalid column / missing task / same column are no-ops (as the callers were)
      if (!(COLS as string[]).includes(i.col)) return
      const prev = state.get().tasks.find(t => t.id === i.id)
      if (!prev || prev.col === i.col) return
      const actor = ctx.actor.kind === 'user' ? 'user' : ctx.actor.kind === 'watcher' ? 'watcher' : 'system'
      const moved = createHistoryEntry({
        category: 'lifecycle', actor, kind: 'move', text: `Moved ${prev.col} → ${i.col}`,
        taskId: prev.id, taskTitle: prev.title,
      })
      state.update(s => ({ ...s, tasks: s.tasks.map(t => (t.id === i.id
        ? { ...t, col: i.col as BoardCol, history: prependHistory(t.history, moved) }
        : t)) }))
      fireAddonHook('onTaskMoved', { taskId: i.id, title: prev.title, col: i.col, from: prev.col })
    },
  })
}
