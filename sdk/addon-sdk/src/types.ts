// Type surface of the YAAM addon platform, hand-mirrored from the host app
// (app/src/core/addons.ts). Pure types only — runtime constants live in
// permissions.ts. app/src/core/addon-sdk-compat.ts type-checks this mirror
// against the host inside the app's own tsc gate, so drift fails the app
// typecheck until the SDK is updated.

/** Scopes an addon can request in its manifest and the user grants per-addon. */
export type AddonPermission =
  | 'state:read'
  | 'sessions:send'
  | 'sessions:launch'
  | 'tasks'
  | 'schedules'
  | 'agent'
  | 'master:prompt'
  | 'ui'
  | 'storage'
  | 'http'
  | 'secrets'
  | 'exec'

/** Board columns tasks move through (tasks.add/move take plain strings). */
export type BoardColumn = 'backlog' | 'progress' | 'review' | 'done' | 'failed'

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

/** The host-side API shape (exact mirror of the app's AddonApi). Addon code
 *  never sees this directly — views get YaamApi (all methods async over RPC)
 *  and handlers get HandlerApi (sync getState, async everything else). */
export interface HostAddonApi {
  getState: () => Record<string, unknown>
  sendToSession: (sessionId: string, text: string) => void
  launchSession: (command: string, cwd?: string, name?: string) => string | null
  focusSession: (sessionId: string) => void
  focusTask: (taskId: string) => void
  flash: (text: string) => void
  logEvent: (text: string) => void
  notify: (title: string, detail: string) => void
  exec: (cmd: string, cwd?: string) => Promise<{ code: number; output: string }>
  sessions: {
    readOutput: (sessionId: string, lines?: number) => string
    stop: (sessionId: string) => void
  }
  tasks: {
    add: (title: string, col?: string, spec?: AddonTaskSpec) => string
    update: (id: string, patch: AddonTaskSpec & { title?: string }) => void
    rename: (id: string, title: string) => void
    move: (id: string, col: string) => void
    remove: (id: string) => void
    start: (id: string) => void
    restart: (id: string) => void
    chat: (id: string, text: string) => void
    get: (id: string) => Record<string, unknown> | null
    approve: (id: string) => Promise<string>
    reject: (id: string, feedback: string) => void
  }
  templates: {
    list: () => { id: string; name: string; mode: string; typeId: string }[]
    run: (idOrName: string, task?: string) => string | null
  }
  schedules: {
    add: (spec: { name: string; schedule?: string; at?: number; cmd?: string; cwd?: string; task?: AddonTaskSpec & { title: string; startNow?: boolean } }) => string
    toggle: (name: string, on?: boolean) => void
    remove: (name: string) => void
  }
  agent: {
    wake: (note: string) => Promise<string>
  }
  storage: {
    get: (key: string) => unknown
    set: (key: string, value: unknown) => void
    list: () => string[]
    remove: (key: string) => void
  }
  http: {
    request: (method: string, url: string, opts?: { headers?: Record<string, string>; body?: string }) => Promise<{ status: number; contentType: string; text: string }>
  }
  secrets: {
    list: () => Promise<{ name: string; label?: string; set: boolean }[]>
  }
}

/** Turn a host API shape into its RPC form: every method returns a Promise. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K] extends object ? Remote<T[K]> : T[K]
}

/** What addon *views* call through the bridge — all methods async, and
 *  getState typed to the snapshot the host actually sends. */
export type YaamApi = Omit<Remote<HostAddonApi>, 'getState'> & {
  getState: () => Promise<AddonSnapshot>
}

/** What tool/hook *handlers* receive as `api` in the sandbox: getState returns
 *  the injected snapshot synchronously; every other method is an async RPC. */
export type HandlerApi = Omit<Remote<HostAddonApi>, 'getState'> & {
  getState: () => AddonSnapshot
}

// ---------- the read-only state snapshot (host addonSnapshot()) ----------

export interface SnapshotSession {
  id: string
  name: string
  status: string
  ephemeral: boolean
  repo: string
  task: string | null
  summary: string | null
  actionNeeded: string | null
  cwd: string | null
  cost: number
  used: number
  machineId: string | null
  isolated: boolean
}

export interface SnapshotTask {
  id: string
  title: string
  col: BoardColumn
  agentId: string | null
  description: string | null
  criteria: string[]
  watcherNote: string | null
  awaitingUser: boolean
  cwd: string | null
  templateId: string | null
  typeId: string | null
  machineId: string | null
  isolate: boolean
  sessionMode: 'oneshot' | 'interactive'
  scheduleAt: number | null
  chatTail: { role: string; text: string }[]
}

export interface SnapshotCron {
  name: string
  schedule: string
  at: number | null
  on: boolean
  /** human "last fired" label (e.g. "2m ago" / "never") */
  last: string
  action: 'task' | 'template' | 'command' | 'log'
  runs: { at: number; note: string; ok: boolean; taskId: string | null; agentId: string | null }[]
}

export interface AddonSnapshot {
  sessions: SnapshotSession[]
  workspace: string
  tasks: SnapshotTask[]
  templates: { id: string; name: string; mode: string; typeId: string }[]
  machines: { id: string; label: string }[]
  crons: SnapshotCron[]
  events: { time: string; type: string; text: string }[]
  totals: { cost: number; used: number; running: number }
}

// ---------- hooks ----------

/** Event payload each lifecycle hook receives as `input`. */
export interface HookEvents {
  onSessionExit: { sessionId: string; name: string; code: number }
  onNeedsInput: { sessionId: string; name: string; question: string }
  onTaskMoved: { taskId: string; title: string; col: string; from: string }
  onCronFired: { name: string; kind: 'agent' | 'task' | 'command' | 'log' }
}

export type AddonHookName = keyof HookEvents

/** Signature for a TypeScript hook module's default export (the build tool
 *  compiles it into the sandbox's `(input, api)` function-body form). */
export type HookHandler<K extends AddonHookName = AddonHookName> =
  (input: HookEvents[K], api: HandlerApi) => unknown | Promise<unknown>

/** Signature for a TypeScript tool module's default export. */
export type ToolHandler<I = Record<string, unknown>> =
  (input: I, api: HandlerApi) => unknown | Promise<unknown>

// ---------- manifest / package ----------

export interface AddonToolManifest {
  name: string
  description?: string
  /** shorthand: `field: "string! · what it is"` (types: string|number|boolean|array|object, `!` = required) */
  input?: Record<string, string>
  /** full JSON schema; wins over `input` */
  input_schema?: Record<string, unknown>
  /** folder format: path to the handler .js; packed format: the source itself */
  handler: string
}

/** The addon manifest (addon.yaml / addon.json in folder form; the same
 *  object with `view` inlined to `html` once packed to *.yaam.json). */
export interface AddonManifest {
  manifest: number
  name: string
  version: string
  /** minimum host app version required (semver); the host blocks install on
   *  older builds. Omit for no lower bound. */
  minAppVersion?: string
  /** up to 2 chars, usually an emoji */
  icon?: string
  description?: string
  author?: string
  /** HTTPS hosts http.request may reach (exact or `*.` wildcard) */
  hosts?: string[]
  /** keychain secret slots usable via {{secret:NAME}} in http.request */
  secrets?: (string | { name: string; label?: string })[]
  permissions?: AddonPermission[]
  /** folder format: path to the view HTML */
  view?: string
  /** packed format: the inlined single-file view HTML */
  html?: string
  tools?: AddonToolManifest[]
  /** hook name → path (folder) or source (packed); masterPromptAppend is a
   *  prompt fragment for Master, not JS */
  hooks?: Partial<Record<AddonHookName | 'masterPromptAppend', string>>
  /** the addon's own LLM agent */
  agent?: {
    /** path (folder) or text (packed) of the system prompt */
    system: string
    /** hooks that wake it */
    on?: AddonHookName[]
    /** 5-field cron that wakes it */
    every?: string
  }
}
