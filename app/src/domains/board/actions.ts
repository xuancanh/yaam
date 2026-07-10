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
import { sendLineToSession } from '../session/command'
import { withMemoryAppend } from '../master/assistant-memory'
import { resolveDecision } from '../master/harness-stats'
import { updateLocatedTask } from './task-state'

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
  /** open the New-task dialog from anywhere (jumps to the board) */
  openNewTask: () => void
  closeNewTask: () => void
  /** run one of the watcher's one-click options: send it to the task's live
   *  session, record the acceptance, and learn the pattern */
  runTaskSuggestion: (taskId: string, msgId: string, suggestionId: string) => void
  dismissTaskSuggestions: (taskId: string, msgId: string) => void
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  startTask: (taskId: string) => void
  restartTask: (taskId: string) => void
  createTask: (input: { title: string; description: string; criteria: string[]; templateId?: string; typeId?: string; cwd?: string; machineId?: string; isolate?: boolean; sessionMode?: 'oneshot' | 'interactive' }) => void
  updateTask: (id: string, patch: Partial<Pick<BoardTask, 'title' | 'description' | 'criteria' | 'templateId' | 'typeId' | 'cwd' | 'machineId'>>) => void
  sendTaskChat: (taskId: string, text: string) => void
  draftTask: (input: { title: string; description: string; criteria: string[] }) => Promise<TaskSpecDraft | null>
  renameTask: (id: string, title: string) => void
  /** archive = the default "delete": leaves the board, recoverable from the
   *  Archived viewer (the only place hard deletion is offered) */
  archiveTask: (id: string) => void
  restoreTask: (id: string) => void
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
    openNewTask: () => dispatch(s => ({ ...s, view: 'board', newTaskOpen: true })),
    closeNewTask: () => dispatch(s => (s.newTaskOpen ? { ...s, newTaskOpen: false } : s)),

    runTaskSuggestion: (taskId, msgId, suggestionId) => {
      const st = ctx.stateRef.current
      const task = st.tasks.find(t => t.id === taskId)
      const msg = (task?.chat ?? []).find(m => m.id === msgId)
      const sug = msg?.suggestions?.find(x => x.id === suggestionId)
      if (!task || !sug) return
      // target the most recent live session attached to this task
      const live = [...(task.agentIds ?? []), ...(task.agentId ? [task.agentId] : [])]
        .map(id => st.agents.find(a => a.id === id))
        .filter(a => a && (a.status === 'running' || a.status === 'needs'))
      const target = live[live.length - 1]
      if (!target) {
        ctx.pushTaskChat(taskId, 'system', `Could not run “${sug.label}” — no live session is attached to this task.`)
        return
      }
      sendLineToSession(target.id, sug.send)
      dispatch(s => withMemoryAppend({
        ...updateLocatedTask(s, taskId, t => ({
          ...t,
          awaitingUser: false,
          chat: (t.chat ?? []).map(m => (m.id === msgId ? { ...m, suggestions: undefined } : m))
            .concat([{ id: mkId('tc'), role: 'user' as const, text: `▶ ${sug.label}`, at: Date.now() }]),
        })),
        // the click answers the ask — clear it from the worker card the
        // watcher mirrored it onto
        agents: s.agents.map(a => (a.id === target.id && a.actionNeeded ? { ...a, actionNeeded: undefined } : a)),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'suggestion', taskId }, 'accepted', sug.label),
      }, 'patterns', `task "${task.title.slice(0, 70)}" → user picked "${sug.label}" (${sug.send.slice(0, 80)})`))
      ctx.flash(`Sent “${sug.label}”`)
      ctx.logEvent('route', target.id, `Task option · ${sug.label}`)
    },

    dismissTaskSuggestions: (taskId, msgId) => {
      dispatch(s => ({
        ...updateLocatedTask(s, taskId, t => ({
          ...t,
          chat: (t.chat ?? []).map(m => (m.id === msgId ? { ...m, suggestions: undefined } : m)),
        })),
        harnessLog: resolveDecision(s.harnessLog, { kind: 'suggestion', taskId }, 'dismissed'),
      }))
    },
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
          templateId: input.templateId, typeId: input.typeId, cwd: input.cwd, machineId: input.machineId,
          isolate: input.isolate, sessionMode: input.sessionMode,
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
            machineId: input.machineId || undefined,
            isolate: input.isolate || undefined,
            sessionMode: input.sessionMode === 'interactive' ? 'interactive' : undefined,
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
      dispatch(s => {
        // the reply answers the ask — clear it from the task AND from the
        // worker card the watcher mirrored it onto
        const task = s.tasks.find(t => t.id === taskId)
        const workerIds = new Set([...(task?.agentIds ?? []), ...(task?.agentId ? [task.agentId] : [])])
        return {
          ...s,
          tasks: s.tasks.map(t => (t.id === taskId ? { ...t, awaitingUser: false } : t)),
          agents: task?.awaitingUser
            ? s.agents.map(a => (workerIds.has(a.id) && a.actionNeeded ? { ...a, actionNeeded: undefined } : a))
            : s.agents,
        }
      })
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
    archiveTask: id => {
      ctx.disposeWatcher(id) // stop the watcher; the task itself stays recoverable
      for (const [sessionId, binding] of ctx.taskSessions.current) {
        if (binding.taskId === id) ctx.taskSessions.current.delete(sessionId)
      }
      dispatch(s => ({ ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, archived: true, awaitingUser: false } : t)) }))
      ctx.flash('Task archived — restore or delete it from Archived')
    },

    restoreTask: id => {
      dispatch(s => ({ ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, archived: false } : t)) }))
      ctx.flash('Task restored')
    },

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
        const live = (task.agentIds ?? [])
          .map(aid => st.agents.find(a => a.id === aid))
          .find(a => a?.status === 'running' || a?.status === 'needs')
        if (live) return `stop session “${live.name}” before approving and removing its worktree`
        const results = await worktreeMerge(wt.root, `yaam: ${task.title.slice(0, 60)}`).catch(e => [
          { name: 'worktree', status: 'error', detail: e instanceof Error ? e.message : String(e) },
        ])
        const summary = results.map(r => `${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')
        if (results.some(r => r.status === 'error')) {
          ctx.pushTaskChat(taskId, 'system', `Merge failed; the task stays in review.\n${summary}`)
          return summary
        }
        try {
          await worktreeRemove(wt.root)
        } catch (e) {
          const detail = `changes merged, but worktree cleanup failed: ${e instanceof Error ? e.message : String(e)}`
          ctx.pushTaskChat(taskId, 'system', `${detail}. The task stays in review so cleanup can be retried.`)
          return detail
        }
        // the mirror is gone — follow-up sessions must not try to re-enter it
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => (task.agentIds ?? []).includes(a.id)
            ? { ...a, cwd: a.worktree?.base ?? a.cwd, worktree: undefined }
            : a),
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
      const title = stateRef.current.tasks.find(t => t.id === taskId)?.title ?? ''
      ctx.pushTaskChat(taskId, 'user', `Review — changes requested: ${note}`)
      dispatch(s => withMemoryAppend({
        ...s,
        tasks: s.tasks.map(t => (t.id === taskId ? { ...t, col: 'progress' as const, awaitingUser: false } : t)),
      }, 'corrections', comment.trim() ? `review of "${title.slice(0, 60)}" rejected: ${note.slice(0, 140)}` : ''))
      void ctx.runWatcher(taskId,
        `[review] The user reviewed this task's changes and requested changes: ${note}. ` +
        'Relaunch a session (or instruct the current one) to address the feedback, then move the task back to review when done.')
      ctx.logEvent('edit', null, `Requested changes on “${stateRef.current.tasks.find(t => t.id === taskId)?.title.slice(0, 48) ?? taskId}”`)
      ctx.flash('Changes requested — watcher notified')
    },
  }
}
