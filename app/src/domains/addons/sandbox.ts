// Addon code isolation. Installed addon tool/hook handlers are UNTRUSTED code.
// They must not run via `new Function` in the privileged main webview, where they
// inherit ambient authority (fetch, Tauri bridge, app-origin storage/DOM).
// Instead we execute them in an opaque-origin sandboxed iframe
// (sandbox="allow-scripts", no allow-same-origin) under a restrictive CSP that
// denies all network (default-src 'none'), and expose the AddonApi only as
// correlated postMessage RPC that the host validates + permission-checks before
// invoking. Read-only state is passed in as an immutable snapshot.
//
// The transport (iframe) is injectable so the host RPC protocol — the security-
// relevant part — is unit-testable without a real browser frame.
import { ADDON_RPC_METHODS, dispatchAddonRpc } from '../../core/addons'
import type { AddonApi } from '../../core/addons'

type HostMsg =
  | { type: 'yaam:ready' }
  | { type: 'yaam:api'; id: number; method: string; args: unknown[] }
  | { type: 'yaam:result'; callId: number; ok: true; value: unknown }
  | { type: 'yaam:result'; callId: number; ok: false; error: string }

/** A frame that runs the sandbox bootstrap and exchanges messages with the host. */
export interface SandboxFrame {
  /** deliver a message INTO the sandbox */
  post: (msg: unknown) => void
  /** receive messages FROM the sandbox; returns an unsubscribe fn */
  onMessage: (cb: (msg: HostMsg) => void) => () => void
  /** tear the frame down (terminates a running/timed-out handler) */
  destroy: () => void
}

export interface AddonSandbox {
  /** run one handler's source with `input`=arg; api calls RPC back to the host */
  run: (source: string, arg: unknown, api: AddonApi, timeoutMs?: number) => Promise<unknown>
  dispose: () => void
}

const MAX_RESULT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

// The in-sandbox bootstrap. It reconstructs the AddonApi shape from the method
// whitelist (getState returns the injected snapshot synchronously; every other
// method is an async RPC to the host) and runs the handler with no ambient
// authority available (CSP blocks network; opaque origin blocks app globals).
export function sandboxBootstrap(methods: readonly string[]): string {
  return `
"use strict";
const pending = new Map();
let rpcSeq = 0;
function rpc(method, args) {
  return new Promise((res, rej) => {
    const id = ++rpcSeq;
    pending.set(id, { res, rej });
    parent.postMessage({ type: 'yaam:api', id, method, args }, '*');
  });
}
function buildApi(snapshot) {
  const api = { getState: () => snapshot };
  for (const m of ${JSON.stringify(methods)}) {
    if (m === 'getState') continue;
    const parts = m.split('.');
    let obj = api;
    for (let i = 0; i < parts.length - 1; i++) { obj[parts[i] ] = obj[parts[i]] || {}; obj = obj[parts[i]]; }
    obj[parts[parts.length - 1]] = (...args) => rpc(m, args);
  }
  return api;
}
addEventListener('message', async (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'yaam:api-result') {
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); d.ok ? p.res(d.value) : p.rej(new Error(d.error)); }
    return;
  }
  if (d.type === 'yaam:exec') {
    try {
      // api methods are async RPC, so the handler body runs inside an async IIFE
      const fn = new Function('input', 'api', '"use strict"; return (async () => {\\n' + d.source + '\\n})();');
      const out = await fn(d.arg, buildApi(d.snapshot));
      parent.postMessage({ type: 'yaam:result', callId: d.callId, ok: true, value: out }, '*');
    } catch (err) {
      parent.postMessage({ type: 'yaam:result', callId: d.callId, ok: false, error: String((err && err.message) || err) }, '*');
    }
  }
});
parent.postMessage({ type: 'yaam:ready' }, '*');
`.trim()
}

/** The sandboxed HTML document: opaque origin + network-denying CSP + bootstrap. */
export function sandboxDocument(methods: readonly string[]): string {
  return `<!doctype html><html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">` +
    `</head><body><script>${sandboxBootstrap(methods)}</script></body></html>`
}

/** Build the sandbox over a transport. The host validates every api request
 *  against the whitelist and invokes the permission-enforced api; results are
 *  size-capped; a handler that exceeds its deadline is terminated (frame reset). */
export function createAddonSandbox(makeFrame: () => SandboxFrame = createIframeFrame): AddonSandbox {
  let frame: SandboxFrame | undefined
  let offMessage: (() => void) | undefined
  let ready: Promise<void> | undefined
  let markReady: (() => void) | undefined
  let callSeq = 0
  // callId -> settle for the currently running handler
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; api: AddonApi }>()

  const ensureFrame = () => {
    if (frame) return frame
    ready = new Promise<void>(res => { markReady = res })
    frame = makeFrame()
    offMessage = frame.onMessage(msg => { void onHostMessage(msg) })
    return frame
  }

  const onHostMessage = async (msg: HostMsg) => {
    if (msg.type === 'yaam:ready') { markReady?.(); return }
    if (msg.type === 'yaam:api') {
      // A running handler is calling the api. Validate + invoke on the host.
      const call = [...calls.values()][0] // one handler runs at a time
      let reply: { type: 'yaam:api-result'; id: number; ok: true; value: unknown } | { type: 'yaam:api-result'; id: number; ok: false; error: string }
      try {
        if (!(ADDON_RPC_METHODS as readonly string[]).includes(msg.method)) {
          throw new Error(`method "${msg.method}" is not callable from an addon`)
        }
        if (!call) throw new Error('no active addon handler')
        const value = await dispatchAddonRpc(call.api, msg.method, Array.isArray(msg.args) ? msg.args : [])
        reply = { type: 'yaam:api-result', id: msg.id, ok: true, value: capSize(value) }
      } catch (e) {
        reply = { type: 'yaam:api-result', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
      }
      frame?.post(reply)
      return
    }
    if (msg.type === 'yaam:result') {
      const call = calls.get(msg.callId)
      if (!call) return
      calls.delete(msg.callId)
      if (msg.ok) call.resolve(msg.value)
      else call.reject(new Error(msg.error))
    }
  }

  const run = (source: string, arg: unknown, api: AddonApi, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> => {
    const f = ensureFrame()
    const gate = ready!
    const callId = ++callSeq
    // read-only snapshot, honoring the state:read permission (throws → undefined)
    let snapshot: unknown
    try { snapshot = api.getState() } catch { snapshot = undefined }
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!calls.has(callId)) return
        calls.delete(callId)
        // terminate: a runaway/timed-out handler is killed by resetting the frame
        dispose()
        reject(new Error(`addon handler timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      calls.set(callId, {
        resolve: v => { window.clearTimeout(timer); resolve(v) },
        reject: e => { window.clearTimeout(timer); reject(e) },
        api,
      })
      // wait for the sandbox bootstrap before posting, so the exec isn't dropped
      void gate.then(() => { if (calls.has(callId)) f.post({ type: 'yaam:exec', callId, source, arg, snapshot }) })
    })
  }

  const dispose = () => {
    offMessage?.(); offMessage = undefined
    frame?.destroy(); frame = undefined
    ready = undefined; markReady = undefined
    for (const c of calls.values()) c.reject(new Error('addon sandbox disposed'))
    calls.clear()
  }

  return { run, dispose }
}

// Process-wide sandbox shared by all addon handler executions (one hidden frame).
let shared: AddonSandbox | undefined
export function addonSandbox(): AddonSandbox {
  return (shared ??= createAddonSandbox())
}

function capSize(value: unknown): unknown {
  const json = (() => { try { return JSON.stringify(value) } catch { return undefined } })()
  if (json !== undefined && json.length > MAX_RESULT_BYTES) {
    throw new Error(`addon api result exceeds ${MAX_RESULT_BYTES} bytes`)
  }
  return value
}

/** The real transport: a hidden opaque-origin sandboxed iframe. */
function createIframeFrame(): SandboxFrame {
  const iframe = document.createElement('iframe')
  // allow-scripts WITHOUT allow-same-origin => opaque origin (no app-origin access)
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.display = 'none'
  iframe.srcdoc = sandboxDocument(ADDON_RPC_METHODS)
  document.body.appendChild(iframe)
  return {
    post: msg => iframe.contentWindow?.postMessage(msg, '*'),
    onMessage: cb => {
      const handler = (e: MessageEvent) => { if (e.source === iframe.contentWindow) cb(e.data as HostMsg) }
      window.addEventListener('message', handler)
      return () => window.removeEventListener('message', handler)
    },
    destroy: () => iframe.remove(),
  }
}
