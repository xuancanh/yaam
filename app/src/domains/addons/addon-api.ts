// The AddonApi surface exposed to addon views (over RPC), tool handlers, and
// hooks: read state, drive sessions, board-task CRUD, templates, schedules, the
// addon's own agent, and private storage. A pure factory — the provider wraps
// the result with enforcePermissions for the addon's granted scopes.
import type { MutableRefObject } from 'react'
import type { AddonApi } from '../../core/addons'
import { addonSnapshot } from '../../core/addons'
import type { AppState, BoardCol, TaskChatMsg } from '../../core/types'
import { mkId } from '../../shared/id'
import { focusSessionIn } from '../session/layout-state'
import { sendLineToSession } from '../session/command'
import { humanizeCron } from '../schedules/cron'
import { isAltScreen, readScreen } from '../../core/terminals'
import { ACCENT } from '../../core/data'
import * as native from '../../core/native'

export interface AddonApiCtx {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  /** route the PTY write through the shared command (addon actor); falls back to
   *  the direct PTY line when unwired. `addonId` binds the actor for the audit. */
  execCommand?: (name: string, input: unknown, addonId: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string) => string | null
  launchFromTemplate: (templateId: string, task?: string) => string | null
  spawnSessionForTask: (taskId: string) => void
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  flash: (t: string) => void
  logEvent: (text: string) => void
  notify: (title: string, detail: string) => void
  later: (ms: number, fn: () => void) => void
  markUserStopped: (id: string) => void
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  runWatcher: (taskId: string, note: string) => void
  wakeAgent: (addonId: string, note: string) => Promise<string>
}

/** Build the raw (un-permission-checked) AddonApi bound to one addon id. */
export function createAddonApi(ctx: AddonApiCtx, addonId: string): AddonApi {
  const { stateRef, dispatch } = ctx
  return {
    getState: () => addonSnapshot(stateRef.current),
    sendToSession: (sid, text) => {
      if (!stateRef.current.agents.some(a => a.id === sid)) return
      // shared command path (audited, policy-checked as the addon actor); the
      // enforcePermissions wrapper already gated sessions:send, so this is the
      // one write impl, not a second gate. Falls back to the port when unwired.
      if (ctx.execCommand) ctx.execCommand('send_to_session', { sessionId: sid, text: String(text) }, addonId)
      else sendLineToSession(sid, String(text))
    },
    launchSession: (command, cwd, name) => ctx.launchSession(String(command), cwd ? String(cwd) : '', name ? String(name) : undefined),
    focusSession: sid => dispatch(s2 => (s2.agents.some(a => a.id === sid) ? focusSessionIn(s2, sid) : s2)),
    flash: t => ctx.flash(String(t).slice(0, 80)),
    logEvent: t => ctx.logEvent(`[addon] ${String(t).slice(0, 120)}`),
    notify: (title, detail) => ctx.notify(String(title).slice(0, 80), String(detail).slice(0, 120)),
    sessions: {
      readOutput: (sid, lines) => {
        const a = stateRef.current.agents.find(x => x.id === sid)
        if (!a) return ''
        const n = Math.max(1, Math.min(80, Number(lines) || 30))
        const screen = isAltScreen(sid) ? readScreen(sid) : (a.log ?? []).map(l => l.x)
        return screen.filter(l => l.trim()).slice(-n).join('\n')
      },
      stop: sid => {
        if (!stateRef.current.agents.some(a => a.id === sid)) return
        // shared command path (audited, addon actor); enforcePermissions already
        // gated sessions:send. Falls back to the port + stop-flag when unwired.
        if (ctx.execCommand) ctx.execCommand('stop_session', { sessionId: String(sid) }, addonId)
        else { ctx.markUserStopped(String(sid)); native.killSession(String(sid)).catch(() => {}) }
      },
    },
    tasks: {
      add: (title, col, spec) => {
        const id = mkId('t')
        const validCols = ['backlog', 'progress', 'review', 'done', 'failed']
        const column = validCols.includes(String(col)) ? String(col) as BoardCol : 'backlog'
        const sp = (spec ?? {}) as Record<string, unknown>
        const strArr = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
        const input = {
          id, title: String(title).slice(0, 120), col: column, note: 'Task created by an addon',
          description: typeof sp.description === 'string' ? sp.description : undefined,
          criteria: strArr(sp.criteria),
          cwd: typeof sp.cwd === 'string' ? sp.cwd : undefined,
          typeId: typeof sp.typeId === 'string' ? sp.typeId : undefined,
          templateId: typeof sp.templateId === 'string' ? sp.templateId : undefined,
        }
        // shared command (caller-minted id lets us return it over the void seam);
        // enforcePermissions already gated `tasks`. Fall back to a direct dispatch.
        if (ctx.execCommand) ctx.execCommand('add_task', input, addonId)
        else dispatch(s2 => ({ ...s2, tasks: s2.tasks.concat([{
          id, title: input.title, col: column, agentId: null,
          description: input.description, criteria: input.criteria, cwd: input.cwd,
          typeId: input.typeId, templateId: input.templateId,
          chat: [{ id: mkId('tc'), role: 'system', text: 'Task created by an addon', at: Date.now() }],
        }]) }))
        return id
      },
      update: (id, patch) => {
        const p = (patch ?? {}) as Record<string, unknown>
        const strArr = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
        dispatch(s2 => ({
          ...s2,
          tasks: s2.tasks.map(t => (t.id === id ? {
            ...t,
            title: typeof p.title === 'string' && p.title.trim() ? p.title.slice(0, 120) : t.title,
            description: typeof p.description === 'string' ? p.description : t.description,
            criteria: strArr(p.criteria) ?? t.criteria,
            cwd: typeof p.cwd === 'string' ? p.cwd : t.cwd,
            typeId: typeof p.typeId === 'string' ? p.typeId : t.typeId,
            templateId: typeof p.templateId === 'string' ? p.templateId : t.templateId,
          } : t)),
        }))
      },
      rename: (id, title) => dispatch(s2 => ({
        ...s2,
        tasks: s2.tasks.map(t => (t.id === id ? { ...t, title: String(title).slice(0, 120) || t.title } : t)),
      })),
      move: (id, col) => {
        if (ctx.execCommand) { ctx.execCommand('move_task', { id: String(id), col: String(col) }, addonId); return }
        const validCols = ['backlog', 'progress', 'review', 'done', 'failed']
        if (!validCols.includes(String(col))) return
        const prev = stateRef.current.tasks.find(t => t.id === id)
        if (!prev || prev.col === col) return
        dispatch(s2 => ({
          ...s2,
          tasks: s2.tasks.map(t => (t.id === id ? { ...t, col: String(col) as BoardCol } : t)),
        }))
        ctx.fireAddonHook('onTaskMoved', { taskId: id, title: prev.title, col: String(col), from: prev.col })
      },
      remove: id => {
        if (ctx.execCommand) ctx.execCommand('remove_task', { id: String(id) }, addonId)
        else dispatch(s2 => ({ ...s2, tasks: s2.tasks.filter(t => t.id !== id) }))
      },
      start: id => ctx.spawnSessionForTask(String(id)),
      restart: id => {
        const t = stateRef.current.tasks.find(x => x.id === id)
        if (!t) return
        const prev = t.agentId ? stateRef.current.agents.find(a => a.id === t.agentId) : undefined
        if (prev && (prev.status === 'running' || prev.status === 'needs')) {
          ctx.markUserStopped(prev.id)
          native.killSession(prev.id).catch(() => {})
        }
        dispatch(s2 => ({ ...s2, tasks: s2.tasks.map(x => (x.id === id ? { ...x, agentId: null } : x)) }))
        ctx.later(50, () => ctx.spawnSessionForTask(String(id)))
      },
      chat: (id, text) => {
        const msg = String(text).trim().slice(0, 2000)
        if (!msg || !stateRef.current.tasks.some(t => t.id === id)) return
        ctx.pushTaskChat(String(id), 'user', msg)
        dispatch(s2 => ({ ...s2, tasks: s2.tasks.map(t => (t.id === id ? { ...t, awaitingUser: false } : t)) }))
        ctx.runWatcher(String(id), `[message from an addon on the user's behalf] ${msg}`)
      },
    },
    templates: {
      list: () => (stateRef.current.templates ?? []).map(t => ({ id: t.id, name: t.name, mode: t.mode, typeId: t.typeId })),
      run: (idOrName, task) => {
        const tpl = (stateRef.current.templates ?? []).find(t => t.id === idOrName || t.name === idOrName)
        return tpl ? ctx.launchFromTemplate(tpl.id, task ? String(task) : undefined) : null
      },
    },
    schedules: {
      add: spec => {
        const sp = (spec ?? {}) as Record<string, unknown>
        const name = String(sp.name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
        if (!name) return 'schedule needs a name'
        const schedule = typeof sp.schedule === 'string' ? sp.schedule.trim() : ''
        const at = typeof sp.at === 'number' && sp.at > Date.now() ? sp.at : undefined
        if (!at && schedule.split(/\s+/).length !== 5) return 'needs a 5-field cron "schedule" or a future epoch-ms "at"'
        const bt = sp.task as (Record<string, unknown> | undefined)
        const boardTask = bt && typeof bt.title === 'string' && bt.title.trim()
          ? {
              title: bt.title.slice(0, 120),
              description: typeof bt.description === 'string' ? bt.description : undefined,
              criteria: Array.isArray(bt.criteria) ? bt.criteria.filter((x): x is string => typeof x === 'string') : undefined,
              templateId: typeof bt.templateId === 'string' ? bt.templateId : undefined,
              typeId: typeof bt.typeId === 'string' ? bt.typeId : undefined,
              cwd: typeof bt.cwd === 'string' ? bt.cwd : undefined,
              startNow: bt.startNow !== false,
            }
          : undefined
        dispatch(s2 => ({
          ...s2,
          crons: s2.crons.concat([{
            id: mkId('c'), name, on: true, built: true, last: 'never',
            schedule: at ? '' : schedule,
            human: at ? `once · ${new Date(at).toLocaleString()}` : humanizeCron(schedule),
            at,
            target: 'workspace', agent: boardTask ? 'Board' : 'Master', color: ACCENT,
            cmd: !boardTask && typeof sp.cmd === 'string' ? sp.cmd : undefined,
            cwd: !boardTask && typeof sp.cwd === 'string' ? sp.cwd : undefined,
            boardTask,
          }]),
        }))
        return `schedule "${name}" created`
      },
      toggle: (name, on) => dispatch(s2 => ({
        ...s2,
        crons: s2.crons.map(c => (c.name === name ? { ...c, on: typeof on === 'boolean' ? on : !c.on } : c)),
      })),
      remove: name => dispatch(s2 => ({ ...s2, crons: s2.crons.filter(c => c.name !== name) })),
    },
    agent: {
      wake: note => ctx.wakeAgent(addonId, String(note)),
    },
    storage: {
      get: key => stateRef.current.addonStorage[addonId]?.[String(key)],
      set: (key, value) => {
        let size = 0
        try { size = (JSON.stringify(value) ?? '').length } catch { throw new Error('storage.set: value is not JSON-serializable') }
        if (size > 262_144) throw new Error('storage.set: value exceeds 256 KB')
        dispatch(s2 => ({
          ...s2,
          addonStorage: {
            ...s2.addonStorage,
            [addonId]: { ...(s2.addonStorage[addonId] ?? {}), [String(key)]: value },
          },
        }))
      },
    },
  }
}
