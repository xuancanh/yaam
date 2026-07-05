// Scheduler runtime: one interval that fires due cron schedules (add a board
// task, queue a template task, or launch a raw command) and starts due scheduled
// tasks — in every workspace. Pure "what's due" lives in ./due; this owns the
// tick + the effectful firing. Self-contained lifecycle (owns its interval).
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, BoardTask, EventType, NotifKind } from '../../core/types'
import { dispatch } from '../../core/store'
import * as native from '../../core/native'
import { mkId } from '../../shared/id'
import { updateLocatedTask } from '../board/task-state'
import { collectDueSchedules, collectDueTasks } from './due'

export interface SchedulerCtx {
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }) => string | null
  spawnTaskSession: (taskId: string, opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string }) => string | null
  fireAddonHook: (hook: 'onCronFired', event: Record<string, unknown>) => void
}

export function useSchedulerRuntime(ctx: SchedulerCtx): void {
  useEffect(() => {
    const { stateRef, logEvent, notify, launchSession, spawnTaskSession, fireAddonHook } = ctx
    const timer = window.setInterval(() => {
      const now = new Date()
      const minuteKey = now.toISOString().slice(0, 16)
      const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const st = stateRef.current
      // schedules fire in every workspace, active or not
      const pools: Array<{ wid: string; crons: typeof st.crons }> = [
        { wid: st.activeWorkspace, crons: st.crons },
        ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, crons: d.crons })),
      ]
      for (const pool of pools) {
        const due = collectDueSchedules(pool.crons, now)
        if (!due.length) continue
        dispatch(s => {
          // one-time schedules (at) disarm after firing
          const mark = (crons: typeof s.crons) => crons.map(c => due.some(x => x.id === c.id)
            ? { ...c, lastFiredMinute: minuteKey, last: `ran · ${timeLabel}`, on: c.at ? false : c.on }
            : c)
          if (pool.wid === s.activeWorkspace) return { ...s, crons: mark(s.crons) }
          const d = s.workspaceData[pool.wid]
          if (!d) return s
          return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, crons: mark(d.crons) } } }
        })
        for (const c of due) {
          fireAddonHook('onCronFired', {
            name: c.name,
            kind: c.boardTask || c.templateId ? 'task' : c.cmd ? 'command' : 'log',
          })
          if (c.boardTask) {
            // schedule adds a task to the kanban board instead of launching;
            // it carries the full task spec, and startNow spawns its watcher-
            // driven one-shot on the next scheduler tick
            const bt = c.boardTask
            const newTask: BoardTask = {
              id: mkId('t'), title: bt.title.slice(0, 120), col: 'backlog', agentId: null,
              description: bt.description,
              criteria: bt.criteria,
              templateId: bt.templateId,
              typeId: bt.typeId,
              cwd: bt.cwd,
              scheduleAt: bt.startNow ? now.getTime() : undefined,
              chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: Date.now() }],
            }
            dispatch(s => {
              if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
              const d = s.workspaceData[pool.wid]
              if (!d) return s
              return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
            })
            logEvent('cron', null, `${c.name} fired · added board task “${bt.title.slice(0, 48)}”`)
            notify('cron', `${c.name} fired`, `added task: ${bt.title.slice(0, 60)}`, null)
            continue
          }
          const tpl = c.templateId ? (st.templates ?? []).find(t => t.id === c.templateId) : undefined
          if (tpl) {
            // template schedules always go through the kanban board: the task
            // starts immediately (next tick) and its watcher drives the run
            const newTask: BoardTask = {
              id: mkId('t'), title: (c.prompt || c.name).slice(0, 120), col: 'backlog', agentId: null,
              description: c.prompt, templateId: tpl.id, scheduleAt: now.getTime(),
              chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: Date.now() }],
            }
            dispatch(s => {
              if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
              const d = s.workspaceData[pool.wid]
              if (!d) return s
              return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
            })
            logEvent('cron', null, `${c.name} fired · queued board task for template “${tpl.name}”`)
            notify('cron', `${c.name} fired`, `board task queued · template ${tpl.name}`, null)
            continue
          }
          const launchedId = !native.isTauri ? null
            : c.cmd ? launchSession(c.cmd, c.cwd || '', c.name, undefined, pool.wid)
            : null
          logEvent('cron', launchedId, `${c.name} fired${c.cmd ? ` · launching ${c.cmd}` : ''}`)
          notify('cron', `${c.name} fired`, c.cmd ? `launched: ${c.cmd}` : 'schedule ran', launchedId)
        }
      }

      // scheduled tasks: spawn a session when their time arrives, in whatever
      // workspace the task lives in. Both active and background go through the
      // one canonical launch path (spawnTaskSession) — no duplicated logic.
      const taskPools: Array<{ wid: string; tasks: typeof st.tasks }> = [
        { wid: st.activeWorkspace, tasks: st.tasks },
        ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, tasks: d.tasks })),
      ]
      for (const pool of taskPools) {
        for (const t of collectDueTasks(pool.tasks, now)) {
          // spawnTaskSession clears scheduleAt on success; clear it on failure
          // (or in a browser build that can't launch) so it doesn't refire every tick
          const id = native.isTauri ? spawnTaskSession(t.id, { workspaceId: pool.wid, briefWatcher: true }) : null
          if (!id) dispatch(s => updateLocatedTask(s, t.id, x => ({ ...x, scheduleAt: undefined }), pool.wid))
          notify('cron', id ? 'Scheduled task started' : 'Scheduled task could not start', t.title.slice(0, 60), id)
        }
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [ctx])
}
