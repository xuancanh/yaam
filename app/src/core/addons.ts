// Addon runtime: package validation, the API surface exposed to addon code,
// and execution of addon tools / hooks. Addons are data (a JSON package) —
// views render in a sandboxed iframe; tool handlers and hooks are JS run in
// the app context against this curated API, so only install trusted packages.
import type { Addon, AddonHookName, AddonPermission, AddonTool, AppState } from './types'
import { cronValidationError } from '../shared/cron-validation'

/** full task spec accepted by tasks.add / tasks.update */
export interface AddonTaskSpec {
  description?: string
  criteria?: string[]
  cwd?: string
  typeId?: string
  templateId?: string
  /** run the task's sessions on a saved remote machine (id from getState().machines) */
  machineId?: string
  /** run in an isolated git worktree (reviewed + merged via the review queue) */
  isolate?: boolean
  /** one-shot (default) or interactive session */
  sessionMode?: 'oneshot' | 'interactive'
  /** epoch ms — the scheduler starts the task at this time */
  scheduleAt?: number
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
  /** jump the app to the board with this task's detail open */
  focusTask: (taskId: string) => void
  /** toast in the UI */
  flash: (text: string) => void
  /** entry in the Activity timeline */
  logEvent: (text: string) => void
  /** notification in the bell popover */
  notify: (title: string, detail: string) => void
  /** run a shell command on the user's machine (translated Claude plugin
   *  hooks live on this) — dangerous scope, never auto-granted */
  exec: (cmd: string, cwd?: string) => Promise<{ code: number; output: string }>
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
    /** full detail of one task (spec, watcher note, chat tail, sessions) */
    get: (id: string) => Record<string, unknown> | null
    /** approve a task sitting in review (merges its worktree if isolated) */
    approve: (id: string) => Promise<string>
    /** send a review back with feedback (the watcher relaunches with it) */
    reject: (id: string, feedback: string) => void
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
    list: () => string[]
    remove: (key: string) => void
  }
  /** outbound HTTP, restricted to the manifest's `hosts` allowlist. Header and
   *  body values may reference {{secret:NAME}} — resolved host-side from the OS
   *  keychain, so addon code never sees the secret value. */
  http: {
    request: (method: string, url: string, opts?: { headers?: Record<string, string>; body?: string }) => Promise<{ status: number; contentType: string; text: string }>
  }
  /** the addon's declared secret slots — names and whether a value is stored;
   *  values are keychain-only and can only be USED via http.request templating */
  secrets: {
    list: () => Promise<{ name: string; label?: string; set: boolean }[]>
  }
}

export const ALL_PERMISSIONS: { id: AddonPermission; label: string }[] = [
  { id: 'state:read', label: 'read app state (sessions + their output, tasks, templates, schedules)' },
  { id: 'sessions:send', label: 'type into / stop sessions' },
  { id: 'sessions:launch', label: 'launch new sessions (incl. templates)' },
  { id: 'tasks', label: 'manage board tasks (spec, spawning, watcher chat)' },
  { id: 'schedules', label: 'create / toggle / remove schedules' },
  { id: 'agent', label: "wake the addon's own LLM agent (spends API tokens)" },
  { id: 'master:prompt', label: "append directives to Master's system prompt" },
  { id: 'ui', label: 'notifications, toasts, focus, activity log' },
  { id: 'storage', label: 'private key-value storage' },
  { id: 'http', label: 'call HTTP APIs on the hosts the package declares' },
  { id: 'secrets', label: 'use its keychain secrets in those HTTP calls' },
  { id: 'exec', label: 'run shell commands on this machine (plugin hooks)' },
]

/** Scopes that can act on the machine or steer LLMs — never auto-granted on
 *  install; the user turns them on per-addon in Settings. */
export const DANGEROUS_PERMISSIONS: AddonPermission[] = [
  'sessions:send', 'sessions:launch', 'tasks', 'schedules', 'agent', 'master:prompt', 'http', 'secrets', 'exec',
]

// Injected by Vite `define` (app/vite.config.ts) from app/package.json. Declared
// module-locally so this file typechecks anywhere it is imported (incl. the SDK
// tests); undefined under the unit-test runner, where APP_VERSION falls back.
declare const __APP_VERSION__: string | undefined
/** The running app version (injected by Vite; '0.0.0' under the test runner). */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

/** Compare two dotted numeric versions. Returns <0, 0, or >0 like a comparator.
 *  Non-numeric / pre-release suffixes are ignored (compared on the numeric core). */
export function cmpSemver(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const pa = parts(a), pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** Whether the running app satisfies an addon's `minAppVersion` requirement.
 *  No requirement (or an unparseable one) is always compatible. */
export function appCompat(minAppVersion: string | undefined, appVersion = APP_VERSION): { ok: boolean; reason?: string } {
  const min = (minAppVersion ?? '').trim()
  if (!min || !/^\d+(\.\d+)*/.test(min)) return { ok: true }
  if (cmpSemver(appVersion, min) < 0) {
    return { ok: false, reason: `requires app ≥ ${min} — this build is v${appVersion}. Update YAAM to install it.` }
  }
  return { ok: true }
}

/** Which permission each API method requires. */
export const METHOD_PERMISSION: Record<string, AddonPermission> = {
  getState: 'state:read',
  sendToSession: 'sessions:send',
  launchSession: 'sessions:launch',
  focusSession: 'ui',
  focusTask: 'ui',
  flash: 'ui',
  logEvent: 'ui',
  notify: 'ui',
  'sessions.readOutput': 'state:read', 'sessions.stop': 'sessions:send',
  'tasks.add': 'tasks', 'tasks.update': 'tasks', 'tasks.rename': 'tasks', 'tasks.move': 'tasks',
  'tasks.remove': 'tasks', 'tasks.start': 'tasks', 'tasks.restart': 'tasks', 'tasks.chat': 'tasks',
  'tasks.get': 'state:read', 'tasks.approve': 'tasks', 'tasks.reject': 'tasks',
  'templates.list': 'state:read', 'templates.run': 'sessions:launch',
  'schedules.add': 'schedules', 'schedules.toggle': 'schedules', 'schedules.remove': 'schedules',
  'agent.wake': 'agent',
  'storage.get': 'storage', 'storage.set': 'storage', 'storage.list': 'storage', 'storage.remove': 'storage',
  'http.request': 'http',
  'secrets.list': 'secrets',
  exec: 'exec',
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
    focusTask: guard('focusTask', api.focusTask),
    flash: guard('flash', api.flash),
    logEvent: guard('logEvent', api.logEvent),
    notify: guard('notify', api.notify),
    exec: guard('exec', api.exec),
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
      get: guard('tasks.get', api.tasks.get),
      approve: guard('tasks.approve', api.tasks.approve),
      reject: guard('tasks.reject', api.tasks.reject),
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
      list: guard('storage.list', api.storage.list),
      remove: guard('storage.remove', api.storage.remove),
    },
    http: {
      request: guard('http.request', api.http.request),
    },
    secrets: {
      list: guard('secrets.list', api.secrets.list),
    },
  }
}

/** Dotted-path RPC dispatch used by the view bridge (yaam:call messages). */
export const ADDON_RPC_METHODS = [
  'getState', 'sendToSession', 'launchSession', 'focusSession', 'focusTask', 'flash', 'logEvent', 'notify',
  'sessions.readOutput', 'sessions.stop',
  'tasks.add', 'tasks.update', 'tasks.rename', 'tasks.move', 'tasks.remove', 'tasks.start', 'tasks.restart', 'tasks.chat',
  'tasks.get', 'tasks.approve', 'tasks.reject',
  'templates.list', 'templates.run',
  'schedules.add', 'schedules.toggle', 'schedules.remove',
  'agent.wake',
  'storage.get', 'storage.set', 'storage.list', 'storage.remove',
  'http.request',
  'secrets.list',
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
      machineId: a.machineId ?? null, isolated: !!a.worktree,
    })),
    workspace: s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'Default',
    tasks: s.tasks.map(t => ({
      id: t.id, title: t.title, col: t.col, agentId: t.agentId,
      description: t.description ?? null, criteria: t.criteria ?? [],
      watcherNote: t.watcherNote ?? null, awaitingUser: !!t.awaitingUser,
      cwd: t.cwd ?? null, templateId: t.templateId ?? null, typeId: t.typeId ?? null,
      machineId: t.machineId ?? null, isolate: !!t.isolate,
      sessionMode: t.sessionMode ?? 'oneshot', scheduleAt: t.scheduleAt ?? null,
      chatTail: (t.chat ?? []).slice(-5).map(m => ({ role: m.role, text: m.text.slice(0, 300) })),
    })),
    templates: (s.templates ?? []).map(t => ({ id: t.id, name: t.name, mode: t.mode, typeId: t.typeId })),
    machines: (s.settings.machines ?? []).map(m => ({ id: m.id, label: m.label })),
    crons: s.crons.map(c => ({
      name: c.name, schedule: c.schedule, at: c.at ?? null, on: c.on, last: c.last,
      action: c.boardTask ? 'task' : c.templateId ? 'template' : c.cmd ? 'command' : 'log',
      runs: (c.runs ?? []).slice(0, 5).map(r => ({ at: r.at, note: r.note, ok: r.ok, taskId: r.taskId ?? null, agentId: r.agentId ?? null })),
    })),
    events: s.events.slice(0, 10).map(e => ({ time: e.time, type: e.type, text: e.text })),
    totals: {
      cost: Number(s.agents.reduce((n, a) => n + a.cost, 0).toFixed(3)),
      used: Number(s.agents.reduce((n, a) => n + a.used, 0).toFixed(2)),
      running: s.agents.filter(a => a.status === 'running').length,
    },
  }
}

// ---------- addon HTTP: host allowlist + secret templating ----------

/** Is this URL reachable for an addon with the given `hosts` allowlist?
 *  https only (plain http allowed just for localhost); hosts match exactly or
 *  via a leading `*.` wildcard (`*.example.com` also matches example.com). */
export function hostAllowed(hosts: string[] | undefined, url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  const h = u.hostname.toLowerCase()
  const isLocal = h === 'localhost' || h === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return false
  return (hosts ?? []).some(pat => {
    const p = pat.trim().toLowerCase()
    if (!p) return false
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1))
    return h === p
  })
}

/** {{secret:NAME}} — the only way addon code can USE a secret (headers/body of
 *  http.request); the value is substituted host-side and never returned. */
export const SECRET_REF = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g

/** Substitute every {{secret:NAME}} in `text` via `get` (keychain lookup).
 *  A referenced-but-unset secret throws so the addon gets a clear error. */
export async function resolveSecretRefs(text: string, get: (name: string) => Promise<string | null>): Promise<string> {
  const names = [...new Set([...text.matchAll(SECRET_REF)].map(m => m[1]))]
  if (!names.length) return text
  const values = new Map<string, string>()
  for (const name of names) {
    const v = await get(name)
    if (v === null || v === '') throw new Error(`secret "${name}" is not set (Addons → this addon → Secrets)`)
    values.set(name, v)
  }
  return text.replace(SECRET_REF, (_, name: string) => values.get(name) ?? '')
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

/** `<!-- @include path -->` (in markup) or `/* @include path *​/` (in CSS/JS)
 *  markers inside a folder addon's view HTML are replaced with the referenced
 *  file's contents at load/pack time. The in-app loader supplies a canonically
 *  scoped reader so installed folders cannot escape their selected root. */
export const INCLUDE_RE = /<!--\s*@include\s+(\S+)\s*-->|\/\*\s*@include\s+(\S+)\s*\*\//g

/** Resolve every @include marker in view HTML (one level — includes don't nest). */
export async function inlineIncludes(html: string, readRef: (relPath: string) => Promise<string>): Promise<string> {
  const jobs: Promise<string>[] = []
  html.replace(INCLUDE_RE, (_m, a: string, b: string) => {
    jobs.push(readRef(a || b))
    return ''
  })
  const bodies = await Promise.all(jobs)
  let i = 0
  return html.replace(INCLUDE_RE, () => bodies[i++])
}

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
    out.html = await inlineIncludes(await readRef(raw.view.trim()), readRef)
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
  const minAppVersion = typeof raw.minAppVersion === 'string' && /^\d+(\.\d+)*/.test(raw.minAppVersion.trim())
    ? raw.minAppVersion.trim() : undefined
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
        every: typeof agentRaw.every === 'string' && !cronValidationError(agentRaw.every)
          ? agentRaw.every.trim()
          : undefined,
      }
    : undefined
  if (agentRaw && typeof agentRaw.every === 'string' && agentRaw.every.trim() && !agent?.every) {
    throw new Error('agent.every must be a valid 5-field cron expression')
  }
  const hosts = Array.isArray(raw.hosts)
    ? (raw.hosts as unknown[]).filter((x): x is string => typeof x === 'string' && /^(\*\.)?[a-z0-9.-]+$/i.test(x.trim())).map(x => x.trim())
    : undefined
  const secrets = Array.isArray(raw.secrets)
    ? (raw.secrets as unknown[]).flatMap(x => {
        if (typeof x === 'string' && /^[A-Za-z0-9_]+$/.test(x)) return [{ name: x }]
        const o = x as Record<string, unknown>
        if (typeof o?.name === 'string' && /^[A-Za-z0-9_]+$/.test(o.name)) {
          return [{ name: o.name, label: typeof o.label === 'string' ? o.label : undefined }]
        }
        return []
      })
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
    name, version, minAppVersion, icon, html, tools: tools.length ? tools : undefined,
    hooks: hasHooks ? hooks : undefined,
    agent,
    hosts: hosts?.length ? hosts : undefined,
    secrets: secrets?.length ? secrets : undefined,
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
    minAppVersion: a.minAppVersion,
    icon: a.icon,
    description: a.desc,
    author: a.author,
    html: a.html,
    tools: a.tools,
    hooks: a.hooks,
    agent: a.agent,
    hosts: a.hosts,
    secrets: a.secrets,
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

/** Prompt snippets contributed by enabled addons holding the master:prompt scope. */
export function addonPromptAppends(s: AppState): string {
  const parts = s.addons
    .filter(a => a.enabled && a.granted.includes('master:prompt') && a.hooks?.masterPromptAppend)
    .map(a => `[addon: ${a.name}]\n${a.hooks!.masterPromptAppend}`)
  return parts.length ? `\n\nADDON DIRECTIVES (installed by the user):\n${parts.join('\n\n')}` : ''
}

/** Compile and execute a trusted addon handler against the permission-wrapped API. */
async function runHandler(source: string, arg: unknown, api: AddonApi): Promise<unknown> {
  // UNTRUSTED code — never `new Function` in the privileged main webview (that
  // grants ambient fetch/Tauri/app-origin authority). Run it in the opaque-origin
  // sandboxed iframe, where the api is only reachable via validated RPC.
  const { addonSandbox } = await import('../domains/addons/sandbox')
  return await addonSandbox().run(source, arg, api)
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
const addonHookTails = new Map<string, Promise<void>>()

export async function execAddonHook(
  s: AppState,
  hook: AddonHookName,
  event: Record<string, unknown>,
  apiFor: (addonId: string) => AddonApi,
): Promise<void> {
  const jobs: Promise<void>[] = []
  for (const a of s.addons) {
    const src = a.enabled ? a.hooks?.[hook] : undefined
    if (!src) continue
    const api = apiFor(a.id)
    // Lifecycle events can overlap (two task moves, or a cron firing while a
    // task hook runs). Serialize each addon's handlers so storage read/modify/
    // write workflows cannot lose transitions; unrelated addons still run in
    // parallel and one failed handler never poisons its queue.
    const previous = addonHookTails.get(a.id) ?? Promise.resolve()
    const job = previous.catch(() => {}).then(async () => {
      try {
        await runHandler(src, event, api)
      } catch (e) {
        // logEvent is itself permission-guarded (ui) — a hook failure in an
        // addon without that scope must not escape as an unhandled rejection
        try {
          api.logEvent(`addon "${a.name}" ${hook} failed: ${e instanceof Error ? e.message : String(e)}`)
        } catch { /* no ui scope — swallow */ }
      }
    })
    addonHookTails.set(a.id, job)
    void job.finally(() => {
      if (addonHookTails.get(a.id) === job) addonHookTails.delete(a.id)
    })
    jobs.push(job)
  }
  await Promise.all(jobs)
}
