// Board-domain actions: card drag/drop, task CRUD, watcher-driven start/
// restart, task chat, and LLM spec drafting. Composed into the provider's
// action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import { mkId } from '../../shared/id'
import * as native from '../../core/native'
import { draftTaskSpec } from './watcher'
import type { ConductorActions } from '../../app/actions'

export interface BoardActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  dragId: MutableRefObject<string | null>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  spawnSessionForTask: (taskId: string) => void
  startTaskViaWatcher: (taskId: string) => void
  runWatcher: (taskId: string, note: string) => void
  pushTaskChat: (taskId: string, role: 'system' | 'user' | 'watcher', text: string) => void
  markUserStopped: (id: string) => void
  watcherHistories: MutableRefObject<Map<string, ApiMessage[]>>
  watcherQueue: MutableRefObject<Map<string, string[]>>
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
}

type BoardActions = Pick<ConductorActions,
  | 'startCardDrag' | 'enterCol' | 'dropTo' | 'startTask' | 'restartTask' | 'createTask'
  | 'updateTask' | 'sendTaskChat' | 'draftTask' | 'renameTask' | 'deleteTask' | 'scheduleTask'>

export function useBoardActions(ctx: BoardActionsCtx): BoardActions {
  const { dispatch, stateRef, dragId, later } = ctx
  return useMemo(() => ({
    startCardDrag: id => { dragId.current = id },
    enterCol: col => dispatch(s => (s.dragOverCol === col ? s : { ...s, dragOverCol: col })),
    dropTo: col => {
      const id = dragId.current
      dragId.current = null
      const prev = id ? stateRef.current.tasks.find(t => t.id === id) : undefined
      dispatch(s => id
        ? { ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, col } : t)), dragOverCol: null }
        : { ...s, dragOverCol: null })
      if (prev && prev.col !== col) ctx.fireAddonHook('onTaskMoved', { taskId: prev.id, title: prev.title, col, from: prev.col })
      if (id && col === 'progress') {
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
        native.killSession(prev.id).catch(() => {})
      }
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(x => (x.id === taskId ? { ...x, agentId: null } : x)),
      }))
      ctx.pushTaskChat(taskId, 'system', `Relaunching — previous session${prev ? ` “${prev.name}”` : ''} detached`)
      later(50, () => ctx.spawnSessionForTask(taskId))
    },
    createTask: input => {
      const id = mkId('t')
      dispatch(s => ({
        ...s,
        tasks: s.tasks.concat([{
          id,
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
      ctx.watcherHistories.current.delete(id)
      ctx.watcherQueue.current.delete(id)
      for (const [sessionId, binding] of ctx.taskSessions.current) {
        if (binding.taskId === id) ctx.taskSessions.current.delete(sessionId)
      }
      dispatch(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== id) }))
    },
    scheduleTask: (taskId, at, templateId) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => t.id === taskId
        ? { ...t, scheduleAt: at ?? undefined, ...(templateId !== undefined ? { templateId: templateId ?? undefined } : {}) }
        : t),
    })),
  }), [dispatch, stateRef, dragId, later, ctx])
}
