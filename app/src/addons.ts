// Addon runtime: package validation, the API surface exposed to addon code,
// and execution of addon tools / hooks. Addons are data (a JSON package) —
// views render in a sandboxed iframe; tool handlers and hooks are JS run in
// the app context against this curated API, so only install trusted packages.
import type { Addon, AddonPermission, AddonTool, AppState } from './types'

export interface AddonApi {
  /** read-only snapshot: sessions, tasks, crons, events, totals */
  getState: () => Record<string, unknown>
  /** type a message into a session (Enter pressed separately) */
  sendToSession: (sessionId: string, text: string) => void
  /** launch a command as a new session; returns its id or null */
  launchSession: (command: string, cwd?: string, name?: string) => string | null
  /** bring a session into view (its pane/tab) */
  focusSession: (sessionId: string) => void
  /** toast in the UI */
  flash: (text: string) => void
  /** entry in the Activity timeline */
  logEvent: (text: string) => void
  /** notification in the bell popover */
  notify: (title: string, detail: string) => void
  /** board task operations (active workspace) */
  tasks: {
    add: (title: string, col?: string) => string
    rename: (id: string, title: string) => void
    move: (id: string, col: string) => void
    remove: (id: string) => void
    /** spawn a session to handle the task (links the card) */
    start: (id: string) => void
  }
  /** persistent per-addon key-value storage */
  storage: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
  }
}

export const ALL_PERMISSIONS: { id: AddonPermission; label: string }[] = [
  { id: 'state:read', label: 'read app state (sessions, tasks, schedules)' },
  { id: 'sessions:send', label: 'type into sessions' },
  { id: 'sessions:launch', label: 'launch new sessions' },
  { id: 'tasks', label: 'manage board tasks (incl. spawning for tasks)' },
  { id: 'ui', label: 'notifications, toasts, focus, activity log' },
  { id: 'storage', label: 'private key-value storage' },
]

/** Which permission each API method requires. */
export const METHOD_PERMISSION: Record<string, AddonPermission> = {
  getState: 'state:read',
  sendToSession: 'sessions:send',
  launchSession: 'sessions:launch',
  focusSession: 'ui',
  flash: 'ui',
  logEvent: 'ui',
  notify: 'ui',
  'tasks.add': 'tasks', 'tasks.rename': 'tasks', 'tasks.move': 'tasks', 'tasks.remove': 'tasks', 'tasks.start': 'tasks',
  'storage.get': 'storage', 'storage.set': 'storage',
}

/** Wrap an API so every method checks the addon's granted scopes. */
export function enforcePermissions(api: AddonApi, granted: AddonPermission[]): AddonApi {
  const has = (m: string) => granted.includes(METHOD_PERMISSION[m])
  const deny = (m: string) => {
    throw new Error(`permission "${METHOD_PERMISSION[m]}" not granted to this addon (Settings → Addons)`)
  }
  const guard = <A extends unknown[], R>(m: string, fn: (...a: A) => R) =>
    (...a: A): R => (has(m) ? fn(...a) : deny(m))
  return {
    getState: guard('getState', api.getState),
    sendToSession: guard('sendToSession', api.sendToSession),
    launchSession: guard('launchSession', api.launchSession),
    focusSession: guard('focusSession', api.focusSession),
    flash: guard('flash', api.flash),
    logEvent: guard('logEvent', api.logEvent),
    notify: guard('notify', api.notify),
    tasks: {
      add: guard('tasks.add', api.tasks.add),
      rename: guard('tasks.rename', api.tasks.rename),
      move: guard('tasks.move', api.tasks.move),
      remove: guard('tasks.remove', api.tasks.remove),
      start: guard('tasks.start', api.tasks.start),
    },
    storage: {
      get: guard('storage.get', api.storage.get),
      set: guard('storage.set', api.storage.set),
    },
  }
}

/** Dotted-path RPC dispatch used by the view bridge (yaam:call messages). */
export const ADDON_RPC_METHODS = [
  'getState', 'sendToSession', 'launchSession', 'focusSession', 'flash', 'logEvent', 'notify',
  'tasks.add', 'tasks.rename', 'tasks.move', 'tasks.remove', 'tasks.start',
  'storage.get', 'storage.set',
] as const

export async function dispatchAddonRpc(api: AddonApi, method: string, args: unknown[]): Promise<unknown> {
  if (!(ADDON_RPC_METHODS as readonly string[]).includes(method)) {
    throw new Error(`unknown method ${method}`)
  }
  const [ns, fn] = method.includes('.') ? method.split('.') : [null, method]
  const target = ns ? (api as unknown as Record<string, Record<string, unknown>>)[ns] : (api as unknown as Record<string, unknown>)
  const f = (ns ? (target as Record<string, unknown>)[fn] : target[fn]) as (...a: unknown[]) => unknown
  return await f(...args)
}

export function addonSnapshot(s: AppState): Record<string, unknown> {
  return {
    sessions: s.agents.filter(a => !a.archived).map(a => ({
      id: a.id, name: a.name, status: a.status,
      task: a.task ?? null, summary: a.summary ?? null, actionNeeded: a.actionNeeded ?? null,
      cwd: a.cwd ?? null, cost: Number(a.cost.toFixed(3)), used: Number(a.used.toFixed(2)),
    })),
    workspace: s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'Default',
    tasks: s.tasks.map(t => ({ id: t.id, title: t.title, col: t.col, agentId: t.agentId })),
    crons: s.crons.map(c => ({ name: c.name, schedule: c.schedule, on: c.on, last: c.last })),
    events: s.events.slice(0, 10).map(e => ({ time: e.time, type: e.type, text: e.text })),
    totals: {
      cost: Number(s.agents.reduce((n, a) => n + a.cost, 0).toFixed(3)),
      used: Number(s.agents.reduce((n, a) => n + a.used, 0).toFixed(2)),
      running: s.agents.filter(a => a.status === 'running').length,
    },
  }
}

/** Parse + validate a package JSON string. Throws with a readable message. */
export function parseAddonPackage(json: string): Omit<Addon, 'id' | 'enabled' | 'source' | 'createdAt' | 'granted'> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('not valid JSON')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) throw new Error('package needs a "name"')
  const version = typeof raw.version === 'string' ? raw.version : '0.0.0'
  const icon = typeof raw.icon === 'string' && raw.icon ? String(raw.icon).slice(0, 2) : '◆'
  const html = typeof raw.html === 'string' && raw.html.trim() ? raw.html : undefined
  const tools: AddonTool[] = Array.isArray(raw.tools)
    ? (raw.tools as unknown[]).flatMap(t => {
        const o = t as Record<string, unknown>
        if (typeof o?.name !== 'string' || typeof o?.handler !== 'string') return []
        return [{
          name: o.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
          description: typeof o.description === 'string' ? o.description : '',
          input_schema: (o.input_schema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          handler: o.handler,
        }]
      })
    : []
  const hooksRaw = (raw.hooks ?? {}) as Record<string, unknown>
  const hooks = {
    onSessionExit: typeof hooksRaw.onSessionExit === 'string' ? hooksRaw.onSessionExit : undefined,
    onNeedsInput: typeof hooksRaw.onNeedsInput === 'string' ? hooksRaw.onNeedsInput : undefined,
    masterPromptAppend: typeof hooksRaw.masterPromptAppend === 'string' ? hooksRaw.masterPromptAppend : undefined,
  }
  if (!html && !tools.length && !hooks.onSessionExit && !hooks.onNeedsInput && !hooks.masterPromptAppend) {
    throw new Error('package has no view, tools, or hooks')
  }
  const allIds = ALL_PERMISSIONS.map(x => x.id)
  const permissions = Array.isArray(raw.permissions)
    ? (raw.permissions as unknown[]).filter((x): x is AddonPermission => allIds.includes(x as AddonPermission))
    : allIds // legacy packages request everything; visible and revocable in Settings
  return {
    name, version, icon, html, tools: tools.length ? tools : undefined,
    hooks: (hooks.onSessionExit || hooks.onNeedsInput || hooks.masterPromptAppend) ? hooks : undefined,
    desc: typeof raw.description === 'string' ? raw.description : undefined,
    author: typeof raw.author === 'string' ? raw.author : undefined,
    permissions,
  }
}

/** Serialize an installed addon back into a shareable package. */
export function exportAddonPackage(a: Addon): string {
  return JSON.stringify({
    manifest: 2,
    name: a.name,
    version: a.version,
    icon: a.icon,
    description: a.desc,
    author: a.author,
    html: a.html,
    tools: a.tools,
    hooks: a.hooks,
    permissions: a.permissions,
  }, null, 2)
}

/** Tool definitions contributed by enabled addons (namespaced). */
export function addonToolDefs(s: AppState) {
  return s.addons.filter(a => a.enabled && a.tools?.length).flatMap(a =>
    a.tools!.map(t => ({
      name: `addon_${t.name}`,
      description: `[addon: ${a.name}] ${t.description}`,
      input_schema: t.input_schema,
    })))
}

/** Prompt snippets contributed by enabled addons. */
export function addonPromptAppends(s: AppState): string {
  const parts = s.addons
    .filter(a => a.enabled && a.hooks?.masterPromptAppend)
    .map(a => `[addon: ${a.name}]\n${a.hooks!.masterPromptAppend}`)
  return parts.length ? `\n\nADDON DIRECTIVES (installed by the user):\n${parts.join('\n\n')}` : ''
}

async function runHandler(source: string, arg: unknown, api: AddonApi): Promise<unknown> {
  const fn = new Function('input', 'api', `"use strict";\n${source}`)
  return await fn(arg, api)
}

/** Execute an addon-contributed Master tool (name arrives namespaced). */
export async function execAddonTool(s: AppState, name: string, input: Record<string, unknown>, apiFor: (addonId: string) => AddonApi): Promise<string> {
  const plain = name.replace(/^addon_/, '')
  for (const a of s.addons) {
    if (!a.enabled) continue
    const tool = a.tools?.find(t => t.name === plain)
    if (!tool) continue
    try {
      const out = await runHandler(tool.handler, input, apiFor(a.id))
      return typeof out === 'string' ? out : JSON.stringify(out ?? 'ok')
    } catch (e) {
      return `addon tool error: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return `no enabled addon provides tool ${plain}`
}

/** Fire a lifecycle hook across all enabled addons (errors contained). */
export async function execAddonHook(
  s: AppState,
  hook: 'onSessionExit' | 'onNeedsInput',
  event: Record<string, unknown>,
  apiFor: (addonId: string) => AddonApi,
): Promise<void> {
  for (const a of s.addons) {
    const src = a.enabled ? a.hooks?.[hook] : undefined
    if (!src) continue
    const api = apiFor(a.id)
    try {
      await runHandler(src, event, api)
    } catch (e) {
      api.logEvent(`addon "${a.name}" ${hook} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
