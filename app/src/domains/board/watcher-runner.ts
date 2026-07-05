// Per-task watcher LLM loop: a "mini Master" that owns one kanban task — moves
// it across columns, steers/spawns its one-shot worker sessions, and chats with
// the user in the task thread. Extracted from the provider; operates on the
// stable refs/callbacks in `ctx`.
import type { MutableRefObject } from 'react'
import type { Agent, AppState, BoardCol, EventType, NotifKind, TaskChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import { runWatcherTurn } from './watcher'
import type { WatcherExec } from './watcher'
import { isAltScreen, readScreen } from '../../core/terminals'
import { sendLineToSession } from '../../core/state-lib'
import { findTaskInState, updateLocatedTask } from './task-state'

export interface WatcherCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  histories: MutableRefObject<Map<string, ApiMessage[]>>
  busy: MutableRefObject<Set<string>>
  queue: MutableRefObject<Map<string, string[]>>
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  spawnTaskSession: (taskId: string, extra?: string) => string | null
}

/** Serialize watcher turns per task; each turn re-reads task/session state. */
export async function runWatcherLoop(ctx: WatcherCtx, taskId: string, note: string) {
  const st = ctx.stateRef.current.settings
  if (!(st.masterEnabled && hasCreds(st))) return
  if (!findTaskInState(ctx.stateRef.current, taskId)) return
  if (ctx.busy.current.has(taskId)) {
    ctx.queue.current.set(taskId, (ctx.queue.current.get(taskId) ?? []).concat([note]))
    return
  }
  ctx.busy.current.add(taskId)
  try {
    let pending: string[] = [note]
    while (pending.length) {
      const current = pending.join('\n\n')
      pending = []
      // Re-read the task after every tool call so watcher decisions see current state.
      const getTask = () => findTaskInState(ctx.stateRef.current, taskId)?.task
      // Every session ever attached to this task (committed state + fast launch bindings), spawn order.
      const getAgents = () => {
        const t = getTask()
        const bound = Array.from(ctx.taskSessions.current.entries())
          .filter(([, binding]) => binding.taskId === taskId)
          .map(([sid]) => sid)
        const ids = [...new Set([...(t?.agentIds ?? []), ...(t?.agentId ? [t.agentId] : []), ...bound])]
        return ids
          .map(sid => ctx.stateRef.current.agents.find(a => a.id === sid))
          .filter((a): a is Agent => !!a)
      }
      // Primary target for steering: the most recent live session, else the most recent.
      const primaryAgent = () => {
        const all = getAgents()
        return all.filter(a => a.status === 'running' || a.status === 'needs').pop() ?? all[all.length - 1]
      }
      if (!getTask()) break
      let history = ctx.histories.current.get(taskId)
      if (!history) {
        history = []
        ctx.histories.current.set(taskId, history)
      }
      const exec: WatcherExec = {
        moveTask: col => {
          const valid: BoardCol[] = ['backlog', 'progress', 'review', 'done', 'failed']
          if (!valid.includes(col as BoardCol)) return `invalid column "${col}"`
          const t = getTask()
          if (!t) return 'task no longer exists'
          if (t.col === col) return `already in ${col}`
          ctx.dispatch(s2 => updateLocatedTask(s2, taskId, x => ({ ...x, col: col as BoardCol })))
          ctx.pushTaskChat(taskId, 'system', `Watcher moved the task to ${col}`)
          ctx.fireAddonHook('onTaskMoved', { taskId, title: t.title, col, from: t.col })
          ctx.logEvent(col === 'failed' ? 'escalate' : 'edit', t.agentId, `Watcher moved “${t.title.slice(0, 40)}” to ${col}`)
          if (col === 'done') ctx.notify('done', 'Task done', t.title.slice(0, 60), t.agentId)
          if (col === 'failed') ctx.notify('escalate', 'Task failed', t.title.slice(0, 60), t.agentId)
          return `moved to ${col}`
        },
        updateNote: n => {
          ctx.dispatch(s2 => updateLocatedTask(s2, taskId, x => ({ ...x, watcherNote: n.slice(0, 140) })))
          // mirror onto the live worker's status card — the watcher IS its monitor
          const a = primaryAgent()
          const t = getTask()
          if (a && t && (a.status === 'running' || a.status === 'needs')) ctx.applyAgentStatus(a.id, t.title.slice(0, 60), n.slice(0, 140))
          return 'note updated'
        },
        sendToSession: (text, session) => {
          const live = getAgents().filter(a => a.status === 'running' || a.status === 'needs')
          const a = session
            ? live.find(x => x.name === session || x.id === session)
            : live[live.length - 1]
          if (!a) return session ? `no live session named "${session}"` : 'no live session attached to this task'
          sendLineToSession(a.id, text)
          ctx.pushTaskChat(taskId, 'system', `Watcher → ${a.name}: ${text.slice(0, 120)}`)
          return `sent to "${a.name}"`
        },
        askUser: q => {
          const t = getTask()
          ctx.pushTaskChat(taskId, 'watcher', q)
          ctx.dispatch(s2 => updateLocatedTask(s2, taskId, x => ({ ...x, awaitingUser: true })))
          ctx.notify('escalate', `Task “${(t?.title ?? '').slice(0, 40)}” needs you`, q.slice(0, 90), t?.agentId ?? null)
          return 'asked — the user will reply in the task chat'
        },
        checkSession: () => {
          const all = getAgents().slice(-4)
          if (!all.length) return 'no session is attached to this task — spawn one with spawn_session if work is needed'
          return all.map(a => {
            const alive = a.status === 'running' || a.status === 'needs'
            const screen = isAltScreen(a.id) ? readScreen(a.id) : (a.log ?? []).slice(-20).map(l => l.x)
            const tail = screen.filter(l => l.trim()).slice(-12).join('\n')
            return [
              `session "${a.name}" · status: ${a.status} — process ${alive ? 'STILL RUNNING (not finished)' : 'exited'}`,
              a.ephemeral ? 'kind: one-shot — it exits by itself when done; while running it prints little or nothing' : 'kind: interactive',
              a.launchedAt ? `runtime: ${Math.round((Date.now() - a.launchedAt) / 1000)}s` : '',
              a.summary ? `last summary: ${a.summary}` : '',
              `latest output:\n${tail || '(no output yet)'}`,
            ].filter(Boolean).join('\n')
          }).join('\n\n---\n\n')
        },
        spawnSession: extra => {
          const t = getTask()
          if (!t) return 'task no longer exists'
          const live = getAgents().filter(a => a.status === 'running' || a.status === 'needs')
          if (live.length >= 3) return 'refused: 3 sessions are already running for this task — steer or stop one instead'
          const sid = ctx.spawnTaskSession(taskId, extra || undefined)
          if (!sid) return 'failed to spawn (no enabled agent type, or the launch was rejected)'
          const name = ctx.stateRef.current.agents.find(a => a.id === sid)?.name ?? sid
          return `spawned one-shot session "${name}" — its output digests will come to you; it exits by itself when done`
        },
      }
      try {
        const reply = await runWatcherTurn(buildCfg(st, st.monitorModel || undefined), getTask, getAgents, current, history, exec)
        if (reply) ctx.pushTaskChat(taskId, 'watcher', reply)
      } catch (e) {
        ctx.logEvent('escalate', null, `Watcher error: ${e instanceof Error ? e.message : String(e)}`)
      }
      pending = ctx.queue.current.get(taskId) ?? []
      ctx.queue.current.delete(taskId)
    }
  } finally {
    ctx.busy.current.delete(taskId)
  }
}
