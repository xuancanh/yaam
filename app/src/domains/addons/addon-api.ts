// The AddonApi surface exposed to addon views (over RPC), tool handlers, and
// hooks: read state, drive sessions, board-task CRUD, templates, schedules, the
// addon's own agent, and private storage. A pure factory — the provider wraps
// the result with enforcePermissions for the addon's granted scopes.
import type { MutableRefObject } from 'react'
import type { AddonApi } from '../../core/addons'
import { addonSnapshot, hostAllowed, resolveSecretRefs, SECRET_REF } from '../../core/addons'
import type { AppState, BoardCol, TaskChatMsg } from '../../core/types'
import { mkId } from '../../shared/id'
import { focusSessionIn } from '../session/layout-state'
import { sendLineToSession } from '../session/command'
import { humanizeCron } from '../schedules/cron'
import { cronValidationError } from '../../shared/cron-validation'
import { isAltScreen, readScreen } from '../../core/terminals'
import { ACCENT } from '../../core/data'
import { execCommand as runShellCommand } from '../../core/native'
import * as native from '../../core/native'

const ADDON_STORAGE_VALUE_CHARS = 256 * 1024
const ADDON_STORAGE_TOTAL_CHARS = 1024 * 1024
const ADDON_STORAGE_KEY_CHARS = 128

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
  /** approve / send back a task in review (worktree merge included) */
  approveTask: (taskId: string) => Promise<string>
  rejectTask: (taskId: string, comment: string) => void
  /** raw HTTP transport (already CORS-free on desktop); the api layer applies
   *  the host allowlist + secret templating before calling this */
  httpRequest: (method: string, url: string, headers: Record<string, string>, body?: string) => Promise<{ status: number; text: string; contentType: string }>
  /** OS-keychain read for {{secret:NAME}} resolution; null when unset */
  secretGet: (account: string) => Promise<string | null>
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
    // pure UI navigation: switch to the board and hand the task id to it —
    // no data leaves the app, and unknown/archived tasks are a no-op
    focusTask: tid => dispatch(s2 => (s2.tasks.some(t => t.id === tid && !t.archived)
      ? { ...s2, view: 'board', focusTaskId: String(tid) }
      : s2)),
    flash: t => ctx.flash(String(t).slice(0, 80)),
    logEvent: t => ctx.logEvent(`[addon] ${String(t).slice(0, 120)}`),
    notify: (title, detail) => ctx.notify(String(title).slice(0, 80), String(detail).slice(0, 120)),
    // permission-gated shell execution (the enforcement wrapper denies it
    // unless the user granted the dangerous 'exec' scope to this addon)
    exec: async (cmd, cwd) => await runShellCommand(String(cmd), cwd ? String(cwd) : undefined, 120_000),
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
          machineId: typeof sp.machineId === 'string' ? sp.machineId : undefined,
          isolate: sp.isolate === true ? true : undefined,
          sessionMode: sp.sessionMode === 'interactive' ? 'interactive' as const : undefined,
          scheduleAt: typeof sp.scheduleAt === 'number' && sp.scheduleAt > Date.now() ? sp.scheduleAt : undefined,
        }
        // shared command (caller-minted id lets us return it over the void seam);
        // enforcePermissions already gated `tasks`. Fall back to a direct dispatch.
        if (ctx.execCommand) ctx.execCommand('add_task', input, addonId)
        else dispatch(s2 => ({ ...s2, tasks: s2.tasks.concat([{
          id, title: input.title, col: column, agentId: null,
          description: input.description, criteria: input.criteria, cwd: input.cwd,
          typeId: input.typeId, templateId: input.templateId,
          machineId: input.machineId, isolate: input.isolate,
          sessionMode: input.sessionMode, scheduleAt: input.scheduleAt,
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
            machineId: typeof p.machineId === 'string' ? p.machineId : t.machineId,
            isolate: typeof p.isolate === 'boolean' ? p.isolate : t.isolate,
            sessionMode: p.sessionMode === 'interactive' || p.sessionMode === 'oneshot' ? p.sessionMode : t.sessionMode,
            scheduleAt: typeof p.scheduleAt === 'number' && p.scheduleAt > Date.now() ? p.scheduleAt : t.scheduleAt,
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
      get: id => {
        const t = stateRef.current.tasks.find(x => x.id === id)
        if (!t) return null
        return {
          id: t.id, title: t.title, col: t.col, agentId: t.agentId, agentIds: t.agentIds ?? [],
          description: t.description ?? null, criteria: t.criteria ?? [],
          watcherNote: t.watcherNote ?? null, awaitingUser: !!t.awaitingUser,
          cwd: t.cwd ?? null, templateId: t.templateId ?? null, typeId: t.typeId ?? null,
          machineId: t.machineId ?? null, isolate: !!t.isolate,
          sessionMode: t.sessionMode ?? 'oneshot', scheduleAt: t.scheduleAt ?? null,
          chat: (t.chat ?? []).slice(-20).map(m => ({ role: m.role, text: m.text.slice(0, 500), at: m.at })),
        }
      },
      approve: async id => {
        if (!stateRef.current.tasks.some(t => t.id === id)) return 'task not found'
        return await ctx.approveTask(String(id))
      },
      reject: (id, feedback) => {
        if (!stateRef.current.tasks.some(t => t.id === id)) return
        ctx.rejectTask(String(id), String(feedback ?? '').slice(0, 2000))
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
        if (!at && cronValidationError(schedule)) return 'needs a valid 5-field cron "schedule" or a future epoch-ms "at"'
        const bt = sp.task as (Record<string, unknown> | undefined)
        const boardTask = bt && typeof bt.title === 'string' && bt.title.trim()
          ? {
              title: bt.title.slice(0, 120),
              description: typeof bt.description === 'string' ? bt.description : undefined,
              criteria: Array.isArray(bt.criteria) ? bt.criteria.filter((x): x is string => typeof x === 'string') : undefined,
              templateId: typeof bt.templateId === 'string' ? bt.templateId : undefined,
              typeId: typeof bt.typeId === 'string' ? bt.typeId : undefined,
              cwd: typeof bt.cwd === 'string' ? bt.cwd : undefined,
              machineId: typeof bt.machineId === 'string' ? bt.machineId : undefined,
              isolate: bt.isolate === true ? true : undefined,
              sessionMode: bt.sessionMode === 'interactive' ? 'interactive' as const : undefined,
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
      toggle: (name, on) => {
        // schedules are keyed by id in the command; resolve the (unique) name
        const c = stateRef.current.crons.find(x => x.name === name)
        if (c && ctx.execCommand) ctx.execCommand('toggle_schedule', { id: c.id, on: typeof on === 'boolean' ? on : undefined }, addonId)
        else dispatch(s2 => ({ ...s2, crons: s2.crons.map(x => (x.name === name ? { ...x, on: typeof on === 'boolean' ? on : !x.on } : x)) }))
      },
      remove: name => {
        const c = stateRef.current.crons.find(x => x.name === name)
        if (c && ctx.execCommand) ctx.execCommand('remove_schedule', { id: c.id }, addonId)
        else dispatch(s2 => ({ ...s2, crons: s2.crons.filter(x => x.name !== name) }))
      },
    },
    agent: {
      wake: note => ctx.wakeAgent(addonId, String(note)),
    },
    storage: {
      get: key => stateRef.current.addonStorage[addonId]?.[String(key)],
      set: (key, value) => {
        const storageKey = String(key)
        if (!storageKey || storageKey.length > ADDON_STORAGE_KEY_CHARS) throw new Error('storage.set: key must be 1-128 characters')
        let encoded: string | undefined
        try { encoded = JSON.stringify(value) } catch { throw new Error('storage.set: value is not JSON-serializable') }
        if (encoded === undefined) throw new Error('storage.set: value is not JSON-serializable')
        if (encoded.length > ADDON_STORAGE_VALUE_CHARS) throw new Error('storage.set: value exceeds 256 KB')
        const next = { ...(stateRef.current.addonStorage[addonId] ?? {}), [storageKey]: value }
        if (JSON.stringify(next).length > ADDON_STORAGE_TOTAL_CHARS) throw new Error('storage.set: addon storage exceeds 1 MB')
        dispatch(s2 => ({
          ...s2,
          addonStorage: {
            ...s2.addonStorage,
            [addonId]: { ...(s2.addonStorage[addonId] ?? {}), [storageKey]: value },
          },
        }))
      },
      list: () => Object.keys(stateRef.current.addonStorage[addonId] ?? {}),
      remove: key => dispatch(s2 => {
        const mine = { ...(s2.addonStorage[addonId] ?? {}) }
        delete mine[String(key)]
        return { ...s2, addonStorage: { ...s2.addonStorage, [addonId]: mine } }
      }),
    },
    http: {
      request: async (method, url, opts) => {
        const addon = stateRef.current.addons.find(a => a.id === addonId)
        const m = String(method).toUpperCase()
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m)) {
          throw new Error(`http.request: method ${m} is not allowed`)
        }
        const u = String(url)
        if (!hostAllowed(addon?.hosts, u)) {
          throw new Error(`http.request: host not allowed — the manifest declares hosts: [${(addon?.hosts ?? []).join(', ') || 'none'}] (https only)`)
        }
        // secrets travel in headers/body only — never in the URL, where they
        // would leak into logs and query strings
        if ([...u.matchAll(SECRET_REF)].length) {
          throw new Error('http.request: {{secret:…}} is not allowed in the URL — put it in a header or the body')
        }
        const getSecret = async (name: string) => {
          if (!(addon?.secrets ?? []).some(sd => sd.name === name)) {
            throw new Error(`secret "${name}" is not declared in this addon's manifest`)
          }
          if (!addon?.granted.includes('secrets')) {
            throw new Error('permission "secrets" not granted to this addon (Settings → Addons)')
          }
          return await ctx.secretGet(`addon:${addonId}:${name}`)
        }
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(opts?.headers ?? {})) {
          headers[String(k)] = await resolveSecretRefs(String(v), getSecret)
        }
        const body = opts?.body !== undefined ? await resolveSecretRefs(String(opts.body), getSecret) : undefined
        const res = await ctx.httpRequest(m, u, headers, body)
        // keep responses under the sandbox RPC result cap
        return { status: res.status, contentType: res.contentType, text: res.text.slice(0, 200_000) }
      },
    },
    secrets: {
      list: async () => {
        const addon = stateRef.current.addons.find(a => a.id === addonId)
        const out: { name: string; label?: string; set: boolean }[] = []
        for (const sd of addon?.secrets ?? []) {
          const v = await ctx.secretGet(`addon:${addonId}:${sd.name}`)
          out.push({ name: sd.name, label: sd.label, set: !!v })
        }
        return out
      },
    },
  }
}
