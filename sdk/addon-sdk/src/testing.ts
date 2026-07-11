// Host stub for developing and testing addon views outside YAAM. It speaks
// the same postMessage protocol as the real host (yaam:call / yaam:result /
// yaam:state / yaam:getState), enforces the same permission map, and backs
// storage with an in-memory Map — so a view built on the bridge (or the React
// bindings) runs unchanged in a plain browser tab or a jsdom test.
import { ADDON_RPC_METHODS, METHOD_PERMISSION, ALL_PERMISSIONS } from './permissions'
import type { AddonPermission, AddonSnapshot, SnapshotTask } from './types'

export interface RecordedCall {
  method: string
  args: unknown[]
}

export interface HostStubOptions {
  /** snapshot fields to override on top of `fixtureSnapshot()` */
  state?: Partial<AddonSnapshot>
  /** granted scopes; defaults to every permission */
  granted?: AddonPermission[] | 'all'
  /** preloaded storage contents */
  storage?: Record<string, unknown>
  /** per-method overrides / additions, e.g. `{ 'http.request': async () => ... }` */
  handlers?: Record<string, (...args: unknown[]) => unknown>
  /** window to attach to (defaults to the global `window`) */
  window?: Window
}

export interface HostStub {
  /** every RPC the view made, in order */
  calls: RecordedCall[]
  /** the live snapshot the stub serves; mutate then `pushState()` */
  state: AddonSnapshot
  /** in-memory storage backing storage.* */
  storage: Map<string, unknown>
  /** merge a patch into the snapshot and push it to subscribers */
  pushState: (patch?: Partial<AddonSnapshot>) => void
  /** change grants at runtime (e.g. to test the ungranted state) */
  setGranted: (granted: AddonPermission[] | 'all') => void
  /** stop listening */
  dispose: () => void
}

let stubIds = 0

/** A plausible default snapshot: two sessions, three tasks, a template, a
 *  machine, a schedule, a few events. Override any field via the argument. */
export function fixtureSnapshot(patch: Partial<AddonSnapshot> = {}): AddonSnapshot {
  const now = Date.now()
  const task = (id: string, title: string, col: SnapshotTask['col'], extra: Partial<SnapshotTask> = {}): SnapshotTask => ({
    id, title, col, agentId: null, description: null, criteria: [], watcherNote: null,
    awaitingUser: false, cwd: null, templateId: null, typeId: null, machineId: null,
    isolate: false, sessionMode: 'oneshot', scheduleAt: null, chatTail: [], ...extra,
  })
  return {
    sessions: [
      { id: 's1', name: 'fix flaky auth test', status: 'running', ephemeral: false, repo: 'yaam', task: 't2', summary: 'rerunning the suite', actionNeeded: null, cwd: '/repo', cost: 0.42, used: 3.1, machineId: null, isolated: false },
      { id: 's2', name: 'docs sweep', status: 'done', ephemeral: true, repo: 'yaam', task: null, summary: null, actionNeeded: null, cwd: '/repo', cost: 0.05, used: 0.4, machineId: null, isolated: false },
    ],
    workspace: 'Default',
    tasks: [
      task('t1', 'Add rate limiting to the sync endpoint', 'backlog'),
      task('t2', 'Fix flaky auth test', 'progress', { agentId: 's1', watcherNote: 'rerunning the suite' }),
      task('t3', 'Upgrade CI runners', 'done'),
    ],
    templates: [{ id: 'tpl1', name: 'Claude oneshot', mode: 'oneshot', typeId: 'claude' }],
    machines: [{ id: 'm1', label: 'build box' }],
    crons: [{ name: 'nightly-sync', schedule: '0 3 * * *', at: null, on: true, last: '6h ago', action: 'task', runs: [{ at: now - 6 * 3600e3, note: 'added task "sync"', ok: true, taskId: 't3', agentId: null }] }],
    events: [{ time: '09:14', type: 'launch', text: 'session "fix flaky auth test" started' }],
    totals: { cost: 0.47, used: 3.5, running: 1 },
    ...patch,
  }
}

/** Start a host stub on `window`. Create it before the view's bridge client
 *  connects (or call `pushState()` after) so the first `yaam:getState` lands. */
export function createHostStub(opts: HostStubOptions = {}): HostStub {
  const win = opts.window ?? window
  const state = fixtureSnapshot(opts.state)
  const storage = new Map<string, unknown>(Object.entries(opts.storage ?? {}))
  const calls: RecordedCall[] = []
  let granted: AddonPermission[] = opts.granted === 'all' || opts.granted === undefined
    ? ALL_PERMISSIONS.map(p => p.id)
    : opts.granted

  const post = (msg: unknown, source?: MessageEventSource | null) => {
    ;((source ?? win) as Window).postMessage(msg, '*')
  }
  const pushTo = (source?: MessageEventSource | null) => {
    const allowed = granted.includes('state:read')
    // clone per push: real browsers structured-clone postMessage payloads (so
    // every host push is a fresh object); jsdom passes references through,
    // which would make React setState bail out on identity
    post({ type: 'yaam:state', state: allowed ? structuredClone(state) : null, denied: allowed ? undefined : 'state:read' }, source)
  }

  // Built-in behaviors for the methods a view most often exercises; anything
  // else records the call and resolves undefined (override via opts.handlers).
  const builtin: Record<string, (...args: unknown[]) => unknown> = {
    getState: () => state,
    'storage.get': (key: unknown) => storage.get(String(key)),
    'storage.set': (key: unknown, value: unknown) => { storage.set(String(key), value) },
    'storage.list': () => [...storage.keys()],
    'storage.remove': (key: unknown) => { storage.delete(String(key)) },
    'tasks.add': (title: unknown, col?: unknown, spec?: unknown) => {
      const id = `stub-t${++stubIds}`
      const s = (spec ?? {}) as Partial<SnapshotTask>
      state.tasks.push({
        id, title: String(title), col: (col ? String(col) : 'backlog') as SnapshotTask['col'],
        agentId: null, description: (s.description as string | undefined) ?? null,
        criteria: s.criteria ?? [], watcherNote: null, awaitingUser: false,
        cwd: (s.cwd as string | undefined) ?? null, templateId: null, typeId: null,
        machineId: null, isolate: !!s.isolate, sessionMode: s.sessionMode ?? 'oneshot',
        scheduleAt: s.scheduleAt ?? null, chatTail: [],
      })
      return id
    },
    'tasks.move': (id: unknown, col: unknown) => {
      const t = state.tasks.find(x => x.id === id)
      if (t) t.col = String(col) as SnapshotTask['col']
    },
    'tasks.remove': (id: unknown) => {
      state.tasks = state.tasks.filter(x => x.id !== id)
    },
    'tasks.get': (id: unknown) => state.tasks.find(x => x.id === id) ?? null,
    'templates.list': () => state.templates,
    'secrets.list': () => [],
    'http.request': () => { throw new Error('no http handler on this stub — pass one via createHostStub({ handlers })') },
  }

  const dispatch = async (method: string, args: unknown[]): Promise<unknown> => {
    if (!ADDON_RPC_METHODS.includes(method)) throw new Error(`unknown method ${method}`)
    const perm = METHOD_PERMISSION[method]
    if (!granted.includes(perm)) throw new Error(`permission "${perm}" not granted to this addon (Settings → Addons)`)
    const fn = opts.handlers?.[method] ?? builtin[method]
    return fn ? await fn(...args) : undefined
  }

  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; callId?: string; method?: string; args?: unknown[] } | null
    if (!d || typeof d !== 'object') return
    if (d.type === 'yaam:getState') pushTo(e.source)
    if (d.type === 'yaam:call' && typeof d.callId === 'string' && typeof d.method === 'string') {
      const args = Array.isArray(d.args) ? d.args : []
      calls.push({ method: d.method, args })
      const { callId } = d
      dispatch(d.method, args)
        .then(result => post({ type: 'yaam:result', callId, result }, e.source))
        .catch((err: unknown) => post({ type: 'yaam:result', callId, error: err instanceof Error ? err.message : String(err) }, e.source))
    }
  }
  win.addEventListener('message', onMessage)

  return {
    calls,
    state,
    storage,
    pushState: patch => {
      Object.assign(state, patch)
      pushTo()
    },
    setGranted: g => {
      granted = g === 'all' ? ALL_PERMISSIONS.map(p => p.id) : g
    },
    dispose: () => { win.removeEventListener('message', onMessage) },
  }
}
