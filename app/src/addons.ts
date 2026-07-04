// Addon runtime: package validation, the API surface exposed to addon code,
// and execution of addon tools / hooks. Addons are data (a JSON package) —
// views render in a sandboxed iframe; tool handlers and hooks are JS run in
// the app context against this curated API, so only install trusted packages.
import type { Addon, AddonHookName, AddonPermission, AddonTool, AppState } from './types'

/** full task spec accepted by tasks.add / tasks.update */
export interface AddonTaskSpec {
  description?: string
  criteria?: string[]
  cwd?: string
  typeId?: string
  templateId?: string
}

export interface AddonApi {
  /** read-only snapshot: sessions, tasks, templates, crons, events, totals */
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
  /** live session inspection & control */
  sessions: {
    /** latest terminal output (rendered screen for TUIs, log tail otherwise) */
    readOutput: (sessionId: string, lines?: number) => string
    /** stop a running session's process */
    stop: (sessionId: string) => void
  }
  /** board task operations (active workspace); started tasks get a watcher */
  tasks: {
    add: (title: string, col?: string, spec?: AddonTaskSpec) => string
    update: (id: string, patch: AddonTaskSpec & { title?: string }) => void
    rename: (id: string, title: string) => void
    move: (id: string, col: string) => void
    remove: (id: string) => void
    /** spawn a watcher-driven one-shot session for the task */
    start: (id: string) => void
    /** detach a dead session and spawn a fresh one-shot */
    restart: (id: string) => void
    /** post a message into the task's watcher chat (the watcher replies there) */
    chat: (id: string, text: string) => void
  }
  /** agent templates (reusable launch configs) */
  templates: {
    list: () => { id: string; name: string; mode: string; typeId: string }[]
    /** launch a template by id or name, optionally with task text; returns session id */
    run: (idOrName: string, task?: string) => string | null
  }
  /** schedules (cron / one-time); task specs go through the kanban board */
  schedules: {
    add: (spec: { name: string; schedule?: string; at?: number; cmd?: string; cwd?: string; task?: AddonTaskSpec & { title: string; startNow?: boolean } }) => string
    toggle: (name: string, on?: boolean) => void
    remove: (name: string) => void
  }
  /** the addon's own LLM harness (declared via the manifest's `agent`) */
  agent: {
    /** wake the agent with a note / user message; resolves to its reply */
    wake: (note: string) => Promise<string>
  }
  /** persistent per-addon key-value storage */
  storage: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
  }
}

export const ALL_PERMISSIONS: { id: AddonPermission; label: string }[] = [
  { id: 'state:read', label: 'read app state (sessions + their output, tasks, templates, schedules)' },
  { id: 'sessions:send', label: 'type into / stop sessions' },
  { id: 'sessions:launch', label: 'launch new sessions (incl. templates)' },
  { id: 'tasks', label: 'manage board tasks (spec, spawning, watcher chat)' },
  { id: 'schedules', label: 'create / toggle / remove schedules' },
  { id: 'agent', label: "wake the addon's own LLM agent (spends API tokens)" },
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
  'sessions.readOutput': 'state:read', 'sessions.stop': 'sessions:send',
  'tasks.add': 'tasks', 'tasks.update': 'tasks', 'tasks.rename': 'tasks', 'tasks.move': 'tasks',
  'tasks.remove': 'tasks', 'tasks.start': 'tasks', 'tasks.restart': 'tasks', 'tasks.chat': 'tasks',
  'templates.list': 'state:read', 'templates.run': 'sessions:launch',
  'schedules.add': 'schedules', 'schedules.toggle': 'schedules', 'schedules.remove': 'schedules',
  'agent.wake': 'agent',
  'storage.get': 'storage', 'storage.set': 'storage',
}

/** Wrap an API so every method checks the addon's granted scopes. */
export function enforcePermissions(api: AddonApi, granted: AddonPermission[]): AddonApi {
  // Test a method against the static method-to-scope map.
  const has = (m: string) => granted.includes(METHOD_PERMISSION[m])
  // Raise a consistent error before denied addon code reaches an implementation.
  const deny = (m: string) => {
    throw new Error(`permission "${METHOD_PERMISSION[m]}" not granted to this addon (Settings → Addons)`)
  }
  // Preserve each method's signature while enforcing its required scope.
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
    sessions: {
      readOutput: guard('sessions.readOutput', api.sessions.readOutput),
      stop: guard('sessions.stop', api.sessions.stop),
    },
    tasks: {
      add: guard('tasks.add', api.tasks.add),
      update: guard('tasks.update', api.tasks.update),
      rename: guard('tasks.rename', api.tasks.rename),
      move: guard('tasks.move', api.tasks.move),
      remove: guard('tasks.remove', api.tasks.remove),
      start: guard('tasks.start', api.tasks.start),
      restart: guard('tasks.restart', api.tasks.restart),
      chat: guard('tasks.chat', api.tasks.chat),
    },
    templates: {
      list: guard('templates.list', api.templates.list),
      run: guard('templates.run', api.templates.run),
    },
    schedules: {
      add: guard('schedules.add', api.schedules.add),
      toggle: guard('schedules.toggle', api.schedules.toggle),
      remove: guard('schedules.remove', api.schedules.remove),
    },
    agent: {
      wake: guard('agent.wake', api.agent.wake),
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
  'sessions.readOutput', 'sessions.stop',
  'tasks.add', 'tasks.update', 'tasks.rename', 'tasks.move', 'tasks.remove', 'tasks.start', 'tasks.restart', 'tasks.chat',
  'templates.list', 'templates.run',
  'schedules.add', 'schedules.toggle', 'schedules.remove',
  'agent.wake',
  'storage.get', 'storage.set',
] as const

/** Validate and invoke one whitelisted dotted addon RPC method. */
export async function dispatchAddonRpc(api: AddonApi, method: string, args: unknown[]): Promise<unknown> {
  if (!(ADDON_RPC_METHODS as readonly string[]).includes(method)) {
    throw new Error(`unknown method ${method}`)
  }
  const [ns, fn] = method.includes('.') ? method.split('.') : [null, method]
  const target = ns ? (api as unknown as Record<string, Record<string, unknown>>)[ns] : (api as unknown as Record<string, unknown>)
  const f = (ns ? (target as Record<string, unknown>)[fn] : target[fn]) as (...a: unknown[]) => unknown
  return await f(...args)
}

/** Produce the bounded, read-only state shape exposed to addon code and views. */
export function addonSnapshot(s: AppState): Record<string, unknown> {
  return {
    sessions: s.agents.filter(a => !a.archived).map(a => ({
      id: a.id, name: a.name, status: a.status, ephemeral: !!a.ephemeral, repo: a.repo,
      task: a.task ?? null, summary: a.summary ?? null, actionNeeded: a.actionNeeded ?? null,
      cwd: a.cwd ?? null, cost: Number(a.cost.toFixed(3)), used: Number(a.used.toFixed(2)),
    })),
    workspace: s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'Default',
    tasks: s.tasks.map(t => ({
      id: t.id, title: t.title, col: t.col, agentId: t.agentId,
      description: t.description ?? null, criteria: t.criteria ?? [],
      watcherNote: t.watcherNote ?? null, awaitingUser: !!t.awaitingUser,
      cwd: t.cwd ?? null, templateId: t.templateId ?? null, typeId: t.typeId ?? null,
      chatTail: (t.chat ?? []).slice(-5).map(m => ({ role: m.role, text: m.text.slice(0, 300) })),
    })),
    templates: (s.templates ?? []).map(t => ({ id: t.id, name: t.name, mode: t.mode, typeId: t.typeId })),
    crons: s.crons.map(c => ({
      name: c.name, schedule: c.schedule, at: c.at ?? null, on: c.on, last: c.last,
      action: c.boardTask ? 'task' : c.templateId ? 'template' : c.cmd ? 'command' : 'log',
    })),
    events: s.events.slice(0, 10).map(e => ({ time: e.time, type: e.type, text: e.text })),
    totals: {
      cost: Number(s.agents.reduce((n, a) => n + a.cost, 0).toFixed(3)),
      used: Number(s.agents.reduce((n, a) => n + a.used, 0).toFixed(2)),
      running: s.agents.filter(a => a.status === 'running').length,
    },
  }
}

// ---------- folder / YAML package format ----------
//
// Single-file packages (*.yaam.json) embed HTML and JS as JSON strings, which
// is miserable to read and debug. The folder format splits an addon into
// plain files referenced from a small manifest:
//
//   my-addon/
//     addon.yaml          (or addon.json — same shape)
//     view.html           html lives in a real .html file
//     tools/audit.js      each tool handler is a real .js file
//     hooks/onTaskMoved.js
//
// The manifest supports a strict YAML subset: `key: value` maps, `- item`
// lists (including lists of maps), 2-space indentation, # comments, quoted or
// plain scalars. Anything fancier throws with a line number — by design.

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  let i = 0
  const err = (msg: string, ln: number): never => { throw new Error(`manifest line ${ln + 1}: ${msg}`) }
  const indentOf = (l: string) => (l.match(/^ */) as RegExpMatchArray)[0].length
  const scalar = (v: string): unknown => {
    const t = v.trim()
    if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) return t.slice(1, -1)
    if (t === 'true') return true
    if (t === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return t
  }
  const skipBlank = () => { while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('#'))) i++ }
  // mappings require ": " (colon + space) or a trailing colon, so plain
  // scalars like state:read or https://… are never mistaken for maps
  const MAP_RE = /^([^:#]+?):(?:\s+(.*))?$/

  function parseBlock(indent: number): unknown {
    skipBlank()
    if (i >= lines.length || indentOf(lines[i]) < indent) return {}
    return lines[i].trim().startsWith('-') ? parseList(indentOf(lines[i])) : parseMap(indentOf(lines[i]))
  }
  function parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (;;) {
      skipBlank()
      if (i >= lines.length) break
      const cur = indentOf(lines[i])
      if (cur < indent) break
      if (cur > indent) err('unexpected indentation', i)
      const t = lines[i].trim()
      if (t.startsWith('-')) err('unexpected list item (expected "key: value")', i)
      const m = t.match(MAP_RE)
      if (!m) err(`expected "key: value", got "${t}"`, i)
      const [, key, rest] = m as RegExpMatchArray
      i++
      out[key.trim()] = rest === undefined || rest === '' ? parseBlock(indent + 2) : scalar(rest)
    }
    return out
  }
  function parseList(indent: number): unknown[] {
    const out: unknown[] = []
    for (;;) {
      skipBlank()
      if (i >= lines.length) break
      const cur = indentOf(lines[i])
      if (cur < indent || !lines[i].trim().startsWith('-')) break
      const rest = lines[i].trim().slice(1).trim()
      if (!rest) { i++; out.push(parseBlock(indent + 2)); continue }
      if (MAP_RE.test(rest) && !/^["']/.test(rest)) {
        // "- key: value" opens a map item; its siblings sit at indent + 2
        lines[i] = ' '.repeat(indent + 2) + rest
        out.push(parseMap(indent + 2))
      } else {
        i++
        out.push(scalar(rest))
      }
    }
    return out
  }
  const root = parseMap(0)
  return root
}

const FILE_REF = /\.(js|html|txt|md)$/i
const SHORTHAND_TYPES = ['string', 'number', 'boolean', 'array', 'object']

/** Expand the manifest's `input:` shorthand (`name: string! · what it is`)
 *  into a JSON tool schema; full `input_schema` passes through untouched. */
export function expandInputShorthand(input: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(input)) {
    const text = String(spec)
    const [head, ...rest] = text.split(/\s*[·–-]\s+/)
    let type = head.trim()
    if (type.endsWith('!')) { required.push(key); type = type.slice(0, -1) }
    if (!SHORTHAND_TYPES.includes(type)) throw new Error(`tool input "${key}": unknown type "${type}" (use ${SHORTHAND_TYPES.join('|')}, append ! if required)`)
    properties[key] = {
      type,
      ...(type === 'array' ? { items: { type: 'string' } } : {}),
      ...(rest.length ? { description: rest.join(' ') } : {}),
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Resolve a folder-format manifest into a canonical single-file package
 *  JSON string (file refs are read through `readRef`, relative to the dir). */
export async function loadAddonFolder(
  manifestText: string,
  readRef: (relPath: string) => Promise<string>,
): Promise<string> {
  const raw: Record<string, unknown> = manifestText.trim().startsWith('{')
    ? JSON.parse(manifestText)
    : parseSimpleYaml(manifestText)
  const ref = async (v: unknown): Promise<string | undefined> => {
    if (typeof v !== 'string' || !v.trim()) return undefined
    return FILE_REF.test(v.trim()) ? await readRef(v.trim()) : v
  }
  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.view === 'string') {
    out.html = await readRef(raw.view.trim())
    delete out.view
  }
  if (Array.isArray(raw.tools)) {
    out.tools = await Promise.all((raw.tools as Record<string, unknown>[]).map(async t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema
        ?? (t.input && typeof t.input === 'object' ? expandInputShorthand(t.input as Record<string, unknown>) : undefined),
      handler: await ref(t.handler),
    })))
  }
  if (raw.hooks && typeof raw.hooks === 'object') {
    const hooks: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw.hooks as Record<string, unknown>)) hooks[k] = await ref(v)
    out.hooks = hooks
  }
  if (raw.agent && typeof raw.agent === 'object') {
    const a = raw.agent as Record<string, unknown>
    out.agent = { ...a, system: await ref(a.system) }
  }
  return JSON.stringify(out)
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
  const hookStr = (k: string) => (typeof hooksRaw[k] === 'string' ? (hooksRaw[k] as string) : undefined)
  const hooks = {
    onSessionExit: hookStr('onSessionExit'),
    onNeedsInput: hookStr('onNeedsInput'),
    onTaskMoved: hookStr('onTaskMoved'),
    onCronFired: hookStr('onCronFired'),
    masterPromptAppend: hookStr('masterPromptAppend'),
  }
  const agentRaw = raw.agent as Record<string, unknown> | undefined
  const HOOK_NAMES = ['onSessionExit', 'onNeedsInput', 'onTaskMoved', 'onCronFired']
  const agent = agentRaw && typeof agentRaw.system === 'string' && agentRaw.system.trim()
    ? {
        system: agentRaw.system,
        on: Array.isArray(agentRaw.on)
          ? (agentRaw.on as unknown[]).filter((x): x is import('./types').AddonHookName => HOOK_NAMES.includes(x as string))
          : undefined,
      }
    : undefined
  const hasHooks = Object.values(hooks).some(Boolean)
  if (!html && !tools.length && !hasHooks && !agent) {
    throw new Error('package has no view, tools, hooks, or agent')
  }
  const allIds = ALL_PERMISSIONS.map(x => x.id)
  const permissions = Array.isArray(raw.permissions)
    ? (raw.permissions as unknown[]).filter((x): x is AddonPermission => allIds.includes(x as AddonPermission))
    : allIds // legacy packages request everything; visible and revocable in Settings
  return {
    name, version, icon, html, tools: tools.length ? tools : undefined,
    hooks: hasHooks ? hooks : undefined,
    agent,
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
    agent: a.agent,
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

/** Compile and execute a trusted addon handler against the permission-wrapped API. */
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
  hook: AddonHookName,
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
