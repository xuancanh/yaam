// Board-domain actions: card drag/drop, task CRUD, watcher-driven start/
// restart, task chat, and LLM spec drafting. Composed into the provider's
// action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, BoardCol, BoardTask } from '../../core/types'
import { buildCfg, hasCreds } from '../../master'
import { mkId } from '../../shared/id'
import { worktreeMerge, worktreeRemove } from '../../core/native'
import { realSessionProcessPort } from '../session/ports'
import type { SessionProcessPort } from '../session/ports'
import { draftTaskSpec } from './watcher'
import type { TaskSpecDraft } from './watcher'

export interface BoardActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  dragId: MutableRefObject<string | null>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  logEvent: (type: import('../../core/types').EventType, agentId: string | null, text: string) => void
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  spawnSessionForTask: (taskId: string) => void
  startTaskViaWatcher: (taskId: string) => void
  runWatcher: (taskId: string, note: string) => void
  pushTaskChat: (taskId: string, role: 'system' | 'user' | 'watcher', text: string) => void
  markUserStopped: (id: string) => void
  /** tear down a task's watcher runtime (cancel in-flight turn + drop registries) on delete */
  disposeWatcher: (taskId: string) => void
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
  /** native PTY capability for detaching a task's previous session on restart */
  port?: SessionProcessPort
  /** application command registry entry point (routes task creation + policy) */
  execCommand?: <R = unknown>(name: string, input: unknown, ctx: { actor: { kind: 'user' } }) => Promise<R>
}

export interface BoardActions {
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  startTask: (taskId: string) => void
  restartTask: (taskId: string) => void
  createTask: (input: { title: string; description: string; criteria: string[]; templateId?: string; typeId?: string; cwd?: string }) => void
  updateTask: (id: string, patch: Partial<Pick<BoardTask, 'title' | 'description' | 'criteria' | 'templateId' | 'typeId' | 'cwd'>>) => void
  sendTaskChat: (taskId: string, text: string) => void
  draftTask: (input: { title: string; description: string; criteria: string[] }) => Promise<TaskSpecDraft | null>
  renameTask: (id: string, title: string) => void
  deleteTask: (id: string) => void
  scheduleTask: (taskId: string, at: number | null, templateId?: string | null) => void
  approveDiff: (id: string) => void
  requestChanges: (id: string) => void
  /** review queue: merge the task's worktree back (when isolated) and move to
   *  done. Resolves to '' on success or a human-readable failure summary. */
  approveTaskReview: (taskId: string) => Promise<string>
  /** review queue: bounce the task to progress with the reviewer's comment */
  rejectTaskReview: (taskId: string, comment: string) => void
}

export function useBoardActions(ctx: BoardActionsCtx): BoardActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createBoardActions(ctx), [ctx.dispatch, ctx.stateRef, ctx.dragId, ctx.later, ctx.flash, ctx.logEvent, ctx.fireAddonHook, ctx.spawnSessionForTask, ctx.startTaskViaWatcher, ctx.runWatcher, ctx.pushTaskChat, ctx.markUserStopped, ctx.disposeWatcher, ctx.taskSessions, ctx.port, ctx.execCommand])
}

/** Plain (non-React) factory for the board/task actions. */
export function createBoardActions(ctx: BoardActionsCtx): BoardActions {
  const { dispatch, stateRef, dragId, later } = ctx
  const port = ctx.port ?? realSessionProcessPort
  return {
    startCardDrag: id => { dragId.current = id },
    enterCol: col => dispatch(s => (s.dragOverCol === col ? s : { ...s, dragOverCol: col })),
    dropTo: col => {
      const id = dragId.current
      dragId.current = null
      dispatch(s => ({ ...s, dragOverCol: null }))
      if (!id) return
      // the column change + onTaskMoved hook go through the shared move_task command
      if (ctx.execCommand) {
        void ctx.execCommand('move_task', { id, col }, { actor: { kind: 'user' } })
      } else {
        const prev = stateRef.current.tasks.find(t => t.id === id)
        dispatch(s => ({ ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, col } : t)) }))
        if (prev && prev.col !== col) ctx.fireAddonHook('onTaskMoved', { taskId: prev.id, title: prev.title, col, from: prev.col })
      }
      if (col === 'progress') {
        const task = stateRef.current.tasks.find(t => t.id === id)
        if (task && !task.agentId) later(50, () => ctx.spawnSessionForTask(id))
      }
    },

    startTask: taskId => ctx.startTaskViaWatcher(taskId),

    restartTask: taskId => {
      const t = stateRef.current.tasks.find(x => x.id === taskId)
      if (!t) return
      const prev = t.agentId ? stateRef.current.agents.find(a => a.id === t.agentId) : undefined
      if (prev && (prev.status === 'running' || prev.status === 'needs')) {
        ctx.markUserStopped(prev.id)
        port.killSession(prev.id).catch(() => {})
      }
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(x => (x.id === taskId ? { ...x, agentId: null } : x)),
      }))
      ctx.pushTaskChat(taskId, 'system', `Relaunching — previous session${prev ? ` “${prev.name}”` : ''} detached`)
      later(50, () => ctx.spawnSessionForTask(taskId))
    },
    createTask: input => {
      // route creation through the shared add_task command (user actor); the
      // toast stays here. Fall back to a direct dispatch when unwired.
      if (ctx.execCommand) {
        void ctx.execCommand('add_task', {
          title: input.title, description: input.description, criteria: input.criteria,
          templateId: input.templateId, typeId: input.typeId, cwd: input.cwd,
        }, { actor: { kind: 'user' } })
      } else {
        dispatch(s => ({
          ...s,
          tasks: s.tasks.concat([{
            id: mkId('t'),
            title: input.title.trim().slice(0, 120),
            col: 'backlog',
            agentId: null,
            description: input.description.trim(),
            criteria: input.criteria.map(c => c.trim()).filter(Boolean),
            templateId: input.templateId || undefined,
            typeId: input.typeId || undefined,
            cwd: input.cwd?.trim() || undefined,
            chat: [{ id: mkId('tc'), role: 'system', text: 'Task created', at: Date.now() }],
          }]),
        }))
      }
      ctx.flash(`Task “${input.title.trim().slice(0, 32)}” created`)
    },
    updateTask: (id, patch) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => (t.id === id ? { ...t, ...patch, title: (patch.title ?? t.title).trim() || t.title } : t)),
    })),
    sendTaskChat: (taskId, text) => {
      const msg = text.trim()
      if (!msg) return
      ctx.pushTaskChat(taskId, 'user', msg)
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(t => (t.id === taskId ? { ...t, awaitingUser: false } : t)),
      }))
      void ctx.runWatcher(taskId, `[user message] ${msg}`)
    },
    draftTask: async input => {
      const st = stateRef.current.settings
      if (!(st.masterEnabled && hasCreds(st))) return null
      return draftTaskSpec(buildCfg(st, st.monitorModel || undefined), input.title, input.description, input.criteria)
    },
    renameTask: (id, title) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => (t.id === id ? { ...t, title: title.trim() || t.title } : t)),
    })),
    deleteTask: id => {
      ctx.disposeWatcher(id) // cancel any in-flight watcher turn + drop its registries
      for (const [sessionId, binding] of ctx.taskSessions.current) {
        if (binding.taskId === id) ctx.taskSessions.current.delete(sessionId)
      }
      if (ctx.execCommand) void ctx.execCommand('remove_task', { id }, { actor: { kind: 'user' } })
      else dispatch(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== id) }))
    },
    scheduleTask: (taskId, at, templateId) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => t.id === taskId
        ? { ...t, scheduleAt: at ?? undefined, ...(templateId !== undefined ? { templateId: templateId ?? undefined } : {}) }
        : t),
    })),

    approveDiff: id => {
      dispatch(s => ({
        ...s,
        drawer: null,
        tasks: s.tasks.map(t => (t.agentId === id && t.col === 'review' ? { ...t, col: 'done' as const } : t)),
      }))
      ctx.logEvent('done', id, 'Approved changes')
      ctx.flash('Changes approved')
    },

    requestChanges: id => {
      dispatch(s => ({ ...s, drawer: null }))
      ctx.logEvent('edit', id, 'Requested changes on the diff')
      ctx.flash('Requested changes')
    },

    approveTaskReview: async taskId => {
      const st = stateRef.current
      const task = st.tasks.find(t => t.id === taskId)
      if (!task) return 'task not found'
      const wt = (task.agentIds ?? [])
        .map(aid => st.agents.find(a => a.id === aid)?.worktree)
        .find(Boolean)
      if (wt) {
        const results = await worktreeMerge(wt.root, `yaam: ${task.title.slice(0, 60)}`).catch(e => [
          { name: 'worktree', status: 'error', detail: e instanceof Error ? e.message : String(e) },
        ])
        const summary = results.map(r => `${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')
        if (results.some(r => r.status === 'error')) {
          ctx.pushTaskChat(taskId, 'system', `Merge failed; the task stays in review.\n${summary}`)
          return summary
        }
        await worktreeRemove(wt.root).catch(() => {})
        // the mirror is gone — follow-up sessions must not try to re-enter it
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => (task.agentIds ?? []).includes(a.id) ? { ...a, worktree: undefined } : a),
        }))
        ctx.pushTaskChat(taskId, 'system', `Review approved — merged back into the original checkout.\n${summary}`)
      } else {
        ctx.pushTaskChat(taskId, 'system', 'Review approved (no worktree — changes were made in place).')
      }
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(t => (t.id === taskId ? { ...t, col: 'done' as const, awaitingUser: false } : t)),
      }))
      ctx.logEvent('done', task.agentId, `Approved review for “${task.title.slice(0, 48)}”`)
      ctx.flash('Approved & merged')
      return ''
    },

    rejectTaskReview: (taskId, comment) => {
      const note = comment.trim() || 'Changes requested (no comment given).'
      ctx.pushTaskChat(taskId, 'user', `Review — changes requested: ${note}`)
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(t => (t.id === taskId ? { ...t, col: 'progress' as const, awaitingUser: false } : t)),
      }))
      void ctx.runWatcher(taskId,
        `[review] The user reviewed this task's changes and requested changes: ${note}. ` +
        'Relaunch a session (or instruct the current one) to address the feedback, then move the task back to review when done.')
      ctx.logEvent('edit', null, `Requested changes on “${stateRef.current.tasks.find(t => t.id === taskId)?.title.slice(0, 48) ?? taskId}”`)
      ctx.flash('Changes requested — watcher notified')
    },
  }
}
