// The view-side host bridge. Addon views run in a sandboxed iframe whose CSP
// denies all network; postMessage to the host is the only channel out. The
// host answers `yaam:call` with a correlated `yaam:result` and pushes
// `yaam:state` snapshots (~3s apart, plus on request).
import type { AddonSnapshot, YaamApi } from './types.js'

export type StateListener = (state: AddonSnapshot | null, denied?: string) => void

export interface YaamClient {
  /** typed RPC tree: `client.api.tasks.add('title')` → Promise */
  api: YaamApi
  /** raw dotted call: `client.call('tasks.add', 'title')` */
  call: (method: string, ...args: unknown[]) => Promise<unknown>
  /** subscribe to snapshot pushes; fires immediately if one already arrived.
   *  `denied` is set (and state null) when state:read is not granted. */
  onState: (cb: StateListener) => () => void
  /** the last snapshot received, if any */
  state: () => AddonSnapshot | null
  /** await a call; on rejection report via `onError` and resolve `fallback` */
  guard: <T>(p: Promise<T>, fallback?: T) => Promise<T | undefined>
  /** remove the message listener (tests / harness teardown) */
  dispose: () => void
}

export interface YaamClientOptions {
  /** where calls are posted; defaults to `window.parent` (which is `window`
   *  itself when the view runs standalone against a testing host stub) */
  target?: Window
  /** called with every `guard`-caught rejection; defaults to the DOM error
   *  banner from `@yaam/addon-sdk/dom` */
  onError?: (message: string) => void
}

let clientSeq = 0

/** Create a bridge client. Views normally use the shared `yaam()` instead. */
export function createYaamClient(opts: YaamClientOptions = {}): YaamClient {
  const target = opts.target ?? window.parent
  const prefix = `sdk${++clientSeq}:`
  let seq = 0
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const subs = new Set<StateListener>()
  let last: AddonSnapshot | null = null

  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; callId?: string; result?: unknown; error?: string; state?: AddonSnapshot | null; denied?: string } | null
    if (!d || typeof d !== 'object') return
    if (d.type === 'yaam:result' && typeof d.callId === 'string') {
      const p = pending.get(d.callId)
      if (!p) return
      pending.delete(d.callId)
      if (d.error !== undefined) p.reject(new Error(String(d.error)))
      else p.resolve(d.result)
    }
    if (d.type === 'yaam:state') {
      last = d.state ?? null
      for (const cb of subs) {
        try { cb(last, d.denied) } catch (err) { console.error(err) }
      }
    }
  }
  window.addEventListener('message', onMessage)

  const call = (method: string, ...args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const callId = prefix + ++seq
      pending.set(callId, { resolve, reject })
      target.postMessage({ type: 'yaam:call', callId, method, args }, '*')
    })

  // api.tasks.add(...) → call('tasks.add', ...); api.flash(...) → call('flash', ...)
  const api = new Proxy({}, {
    get: (_t, ns) => new Proxy(() => {}, {
      apply: (_f, _this, args: unknown[]) => call(String(ns), ...args),
      get: (_t2, method) => (...args: unknown[]) => call(`${String(ns)}.${String(method)}`, ...args),
    }),
  }) as YaamApi

  const report = opts.onError ?? (msg => {
    // lazy import keeps the bridge usable in DOM-less handler tests
    void import('./dom.js').then(m => m.banner(msg)).catch(() => console.error(msg))
  })

  const guard = async <T,>(p: Promise<T>, fallback?: T): Promise<T | undefined> => {
    try { return await p } catch (e) {
      report(e instanceof Error ? e.message : String(e))
      return fallback
    }
  }

  const onState = (cb: StateListener) => {
    subs.add(cb)
    if (last) cb(last)
    target.postMessage({ type: 'yaam:getState' }, '*')
    return () => { subs.delete(cb) }
  }

  return {
    api,
    call,
    onState,
    state: () => last,
    guard,
    dispose: () => {
      window.removeEventListener('message', onMessage)
      pending.clear()
      subs.clear()
    },
  }
}

let shared: YaamClient | undefined

/** The shared client for the running view (created on first use). */
export function yaam(): YaamClient {
  shared ??= createYaamClient()
  return shared
}
