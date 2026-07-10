// Scheduler runtime: one interval that fires due cron schedules (add a board
// task, queue a template task, or launch a raw command) and starts due scheduled
// tasks — in every workspace. Pure "what's due" lives in ./due; this owns the
// tick + the effectful firing. A plain factory over StatePort + ClockPort with an
// explicit start/dispose lifecycle (testable with a fake clock, no React).
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, BoardTask, Cron, CronRun, EventType, NotifKind } from '../../core/types'
import { dispatch } from '../../core/store'
import { browserClock, type ClockPort, type Disposable, type StatePort } from '../../core/ports'
import * as native from '../../core/native'
import { mkId } from '../../shared/id'
import { updateLocatedTask } from '../board/task-state'
import { collectDueSchedules, collectDueTasks } from './due'
import { cronMatches } from './cron'

export interface SchedulerDeps {
  state: StatePort
  clock: ClockPort
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean }) => string | null
  spawnTaskSession: (taskId: string, opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string }) => string | null
  /** deliver a scheduled prompt to a durable agent's conversation (its loop);
   *  returns the conversation id, or null when the agent/brain is unavailable */
  sendAgentChat: (durableAgentId: string, prompt: string, scheduleName: string) => string | null
  fireAddonHook: (hook: 'onCronFired', event: Record<string, unknown>) => void
  /** wake an addon's own agent (its `agent.every` cron loop) */
  wakeAddonAgent: (addonId: string, note: string) => void
  /** whether raw-command / one-shot launches are possible (false in a browser build) */
  canLaunch: boolean
}

export interface SchedulerRuntime {
  start: () => void
  dispose: () => void
}

const TICK_MS = 15000

export function createSchedulerRuntime(deps: SchedulerDeps): SchedulerRuntime {
  const { state, clock, logEvent, notify, launchSession, spawnTaskSession, fireAddonHook, wakeAddonAgent, canLaunch } = deps
  // addonId -> last minute its agent.every fired (once-per-minute guard)
  const agentWakes = new Map<string, string>()

  const tick = () => {
    const st = state.get()
    // don't fire schedules until the runtime has finished restoring — otherwise
    // a slow hydration lets the ticker observe seed state (or double-fire a
    // schedule that restoration is about to re-arm)
    if (st.bootStatus !== 'ready' && st.bootStatus !== 'failed') return
    const now = new Date(clock.now())
    const minuteKey = now.toISOString().slice(0, 16)
    const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    // schedules fire in every workspace, active or not
    const pools: Array<{ wid: string; crons: typeof st.crons }> = [
      { wid: st.activeWorkspace, crons: st.crons },
      ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, crons: d.crons })),
    ]
    for (const pool of pools) {
      const due = collectDueSchedules(pool.crons, now)
      if (!due.length) continue
      state.update(s => {
        // one-time schedules (at) disarm after firing
        const mark = (crons: typeof s.crons) => crons.map(c => due.some(x => x.id === c.id)
          ? { ...c, lastFiredMinute: minuteKey, last: `ran · ${timeLabel}`, on: c.at ? false : c.on }
          : c)
        if (pool.wid === s.activeWorkspace) return { ...s, crons: mark(s.crons) }
        const d = s.workspaceData[pool.wid]
        if (!d) return s
        return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, crons: mark(d.crons) } } }
      })
      // append one history entry (newest first, capped) to the fired schedule
      const recordRun = (cronId: string, run: CronRun) => state.update(s => {
        const upd = (crons: Cron[]) => crons.map(x => x.id === cronId
          ? { ...x, runs: [run, ...(x.runs ?? [])].slice(0, 20) }
          : x)
        if (pool.wid === s.activeWorkspace) return { ...s, crons: upd(s.crons) }
        const d = s.workspaceData[pool.wid]
        if (!d) return s
        return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, crons: upd(d.crons) } } }
      })
      for (const c of due) {
        fireAddonHook('onCronFired', {
          name: c.name,
          kind: c.durableAgentId ? 'agent' : c.boardTask || c.templateId ? 'task' : c.cmd ? 'command' : 'log',
        })
        if (c.durableAgentId && c.agentPrompt) {
          // a durable agent's loop: deliver the prompt to its conversation
          const convId = deps.sendAgentChat(c.durableAgentId, c.agentPrompt, c.name)
          recordRun(c.id, {
            at: now.getTime(),
            note: convId ? `prompted agent: ${c.agentPrompt.slice(0, 60)}` : 'could not reach the agent (archived, or no chat credentials)',
            ok: !!convId,
            agentId: convId ?? undefined,
          })
          logEvent('cron', convId, `${c.name} fired · prompted durable agent`)
          notify('cron', `${c.name} fired`, c.agentPrompt.slice(0, 60), convId)
          continue
        }
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
            machineId: bt.machineId,
            isolate: bt.isolate,
            sessionMode: bt.sessionMode,
            scheduleAt: bt.startNow ? now.getTime() : undefined,
            chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: now.getTime() }],
          }
          state.update(s => {
            if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
            const d = s.workspaceData[pool.wid]
            if (!d) return s
            return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
          })
          recordRun(c.id, { at: now.getTime(), note: `added task “${bt.title.slice(0, 48)}”${bt.startNow ? ' · starting' : ' · to backlog'}`, ok: true, taskId: newTask.id })
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
            chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: now.getTime() }],
          }
          state.update(s => {
            if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
            const d = s.workspaceData[pool.wid]
            if (!d) return s
            return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
          })
          recordRun(c.id, { at: now.getTime(), note: `queued task for template “${tpl.name}”`, ok: true, taskId: newTask.id })
          logEvent('cron', null, `${c.name} fired · queued board task for template “${tpl.name}”`)
          notify('cron', `${c.name} fired`, `board task queued · template ${tpl.name}`, null)
          continue
        }
        const launchedId = !canLaunch ? null
          : c.cmd ? launchSession(c.cmd, c.cwd || '', c.name, undefined, pool.wid)
          : null
        recordRun(c.id, {
          at: now.getTime(),
          note: c.cmd ? (launchedId ? `launched: ${c.cmd.slice(0, 60)}` : `could not launch: ${c.cmd.slice(0, 60)}`) : 'fired (no command — logged only)',
          ok: !c.cmd || !!launchedId,
          agentId: launchedId ?? undefined,
        })
        logEvent('cron', launchedId, `${c.name} fired${c.cmd ? ` · launching ${c.cmd}` : ''}`)
        notify('cron', `${c.name} fired`, c.cmd ? `launched: ${c.cmd}` : 'schedule ran', launchedId)
      }
    }

    // addons with an `agent.every` cron: wake their agent on matching minutes —
    // the addon's own periodic monitor loop (addons are global, not per pool)
    for (const a of st.addons ?? []) {
      if (!a.enabled || !a.agent?.every) continue
      if (!cronMatches(a.agent.every, now) || agentWakes.get(a.id) === minuteKey) continue
      agentWakes.set(a.id, minuteKey)
      wakeAddonAgent(a.id, `[scheduled wake · ${timeLabel}] Run your periodic check now; do nothing if there is nothing to act on.`)
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
        const id = canLaunch ? spawnTaskSession(t.id, { workspaceId: pool.wid, briefWatcher: true }) : null
        if (!id) state.update(s => updateLocatedTask(s, t.id, x => ({ ...x, scheduleAt: undefined }), pool.wid))
        notify('cron', id ? 'Scheduled task started' : 'Scheduled task could not start', t.title.slice(0, 60), id)
      }
    }
  }

  let timer: Disposable | undefined
  return {
    start() { timer = clock.setInterval(tick, TICK_MS) },
    dispose() { timer?.dispose(); timer = undefined },
  }
}

/** React adapter: build the runtime over the real store + browser clock and
 *  bind its lifecycle to the effect. */
export interface SchedulerCtx {
  stateRef: MutableRefObject<AppState>
  logEvent: SchedulerDeps['logEvent']
  notify: SchedulerDeps['notify']
  launchSession: SchedulerDeps['launchSession']
  spawnTaskSession: SchedulerDeps['spawnTaskSession']
  sendAgentChat: SchedulerDeps['sendAgentChat']
  fireAddonHook: SchedulerDeps['fireAddonHook']
  wakeAddonAgent: SchedulerDeps['wakeAddonAgent']
}

export function useSchedulerRuntime(ctx: SchedulerCtx): void {
  useEffect(() => {
    const state: StatePort = { get: () => ctx.stateRef.current, update: dispatch, subscribe: () => () => {} }
    const rt = createSchedulerRuntime({
      state, clock: browserClock, logEvent: ctx.logEvent, notify: ctx.notify,
      launchSession: ctx.launchSession, spawnTaskSession: ctx.spawnTaskSession, sendAgentChat: ctx.sendAgentChat, fireAddonHook: ctx.fireAddonHook,
      wakeAddonAgent: ctx.wakeAddonAgent,
      canLaunch: native.isTauri,
    })
    rt.start()
    return () => rt.dispose()
  }, [ctx])
}
