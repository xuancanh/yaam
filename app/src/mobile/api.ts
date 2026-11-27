// Mobile API layer: relative-path fetches (so the app works on a raw LAN IP,
// a Tailscale/WireGuard address, or behind a Cloudflare Tunnel alike) carrying
// the URL token from the link plus the per-device token minted by the desktop
// pairing approval. The device identity/token persist in localStorage.
import type { RemoteSnapshot } from '../domains/remote/snapshot'

const DEVICE_ID_KEY = 'yaam-remote-device-id'
const DEVICE_TOKEN_KEY = 'yaam-remote-device-token'
const URL_TOKEN_KEY = 'yaam-remote-url-token'

// localStorage can be missing or throw (Safari private mode, test envs) —
// fall back to in-memory so the app still works for the session
const store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage
  } catch { /* blocked storage */ }
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  }
})()

/** URL token from the connect link (?t=…). */
export function urlToken(search = window.location.search): string {
  return new URLSearchParams(search).get('t') ?? ''
}

/** Remember the URL token from a link that authenticated. Every API call needs
 *  it (it is the "possession of the link" factor), and the desktop persists the
 *  same token across restarts — so a remembered one is almost always still
 *  valid, letting a bare bookmark reconnect. */
export function rememberUrlToken(token: string): void {
  if (token) store.setItem(URL_TOKEN_KEY, token)
}

/** The URL token last seen on a working link, if any. */
export function lastUrlToken(): string {
  return store.getItem(URL_TOKEN_KEY) ?? ''
}

/** Resolve the effective URL token. If the address bar has one, use it. If it is
 *  blank (a home-screen shortcut that dropped the query, a bare host), re-apply
 *  the remembered token to the URL WITHOUT reloading, so the app reconnects
 *  instead of dead-ending on the "link out of date" screen. Returns '' only when
 *  no token is available anywhere. */
export function ensureUrlToken(): string {
  const current = urlToken()
  if (current) return current
  const remembered = lastUrlToken()
  if (remembered && typeof window !== 'undefined' && window.history) {
    const url = new URL(window.location.href)
    url.searchParams.set('t', remembered)
    window.history.replaceState(window.history.state, '', url.toString())
    return remembered
  }
  return ''
}

function randId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(36).slice(-1)).join('') + Date.now().toString(36)
}

/** Stable per-browser device id, created on first use. */
export function deviceId(): string {
  let id = store.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = randId()
    store.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

export function deviceToken(): string {
  return store.getItem(DEVICE_TOKEN_KEY) ?? ''
}

export function storeDeviceToken(token: string): void {
  store.setItem(DEVICE_TOKEN_KEY, token)
}

export function forgetPairing(): void {
  store.removeItem(DEVICE_TOKEN_KEY)
}

/** Relative API URL with auth params — never an absolute host. */
export function apiUrl(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams({ t: urlToken(), ...params })
  return `${path}?${q.toString()}`
}

async function getJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(apiUrl(path, params))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

async function postJson<T>(path: string, body: unknown, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(apiUrl(path, params), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Validate the URL token before showing the pairing screen. */
export async function ping(): Promise<boolean> {
  try {
    await getJson<{ ok: boolean }>('/api/ping')
    return true
  } catch {
    return false
  }
}

export async function requestPairing(name: string): Promise<string> {
  const res = await postJson<{ status?: string; error?: string }>('/api/pair/request', {
    device_id: deviceId(),
    name,
  })
  return res.status ?? res.error ?? 'unknown'
}

/** Poll until the desktop approves; stores the minted token when it arrives. */
export async function pairingStatus(): Promise<'pending' | 'paired' | 'unknown' | 'lost'> {
  const res = await getJson<{ status: string; token?: string }>('/api/pair/status', { device: deviceId() })
  if (res.status === 'paired') {
    if (res.token) storeDeviceToken(res.token)
    // The desktop hands a device token out exactly once. If that answer was
    // lost, this phone is "paired" with nothing to prove it, and every call
    // failed forever: start over with a fresh device id instead.
    else if (!deviceToken()) return 'lost'
  }
  return (res.status as 'pending' | 'paired' | 'unknown') ?? 'unknown'
}

/** Drop this phone's identity entirely (token and device id), so the next
 *  pairing request is a new device. */
export function resetDevice(): void {
  store.removeItem(DEVICE_TOKEN_KEY)
  store.removeItem(DEVICE_ID_KEY)
}

/** SSE stream URL for live snapshot pushes. */
export function streamUrl(): string {
  return apiUrl('/api/stream', { d: deviceToken() })
}

export async function fetchState(): Promise<RemoteSnapshot> {
  return await getJson<RemoteSnapshot>('/api/state', { d: deviceToken() })
}

export interface CommandInput {
  kind: string
  id: string
  /** set for queueable messages: lets the desktop drop a resend */
  cid?: string
  agent_id?: string
  text?: string
  ok?: boolean
}

/** Typed messages are the one thing a dropped connection must not eat: the
 *  composer has already cleared, so a failed POST would silently lose what
 *  the user wrote. They wait here and go out, in order, once the desktop is
 *  back. Taps (keys, approvals, stop) are deliberately NOT queued: replaying
 *  an "Approve" minutes later, against whatever is on screen by then, would
 *  be worse than failing. */
const QUEUEABLE = new Set(['master_send', 'chat_send', 'task_chat', 'session_input'])
const OUTBOX_KEY = 'yaam-remote-outbox'

// Messages typed while the desktop is unreachable. Persisted: iOS kills a
// backgrounded tab, and the banner had promised they would send. Each carries
// a client id (`cid`) so a resend after a lost response is acknowledged by the
// desktop instead of delivered twice.
const loadOutbox = (): CommandInput[] => {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : []
    return Array.isArray(parsed) ? parsed.filter((c): c is CommandInput => !!c && typeof c === 'object' && typeof (c as CommandInput).kind === 'string') : []
  } catch { return [] }
}
const outbox: CommandInput[] = loadOutbox()
const outboxListeners = new Set<(n: number) => void>()
const notifyOutbox = () => {
  try {
    if (outbox.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox))
    else localStorage.removeItem(OUTBOX_KEY)
  } catch { /* private mode: the queue still works for this page */ }
  outboxListeners.forEach(f => f(outbox.length))
}

export function onOutbox(f: (n: number) => void): () => void {
  outboxListeners.add(f)
  f(outbox.length)
  return () => { outboxListeners.delete(f) }
}

export function discardOutbox(): void {
  outbox.length = 0
  notifyOutbox()
}

const newCid = () => {
  const b = new Uint8Array(9)
  crypto.getRandomValues(b)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

async function postCommand(cmd: CommandInput): Promise<void> {
  await postJson('/api/command', { agent_id: '', text: '', ok: false, ...cmd }, { d: deviceToken() })
}

/** fetch rejects (TypeError) only when the request never got an answer —
 *  an HTTP error status means the desktop saw it and said no */
const unreachable = (e: unknown) => e instanceof TypeError
/** the desktop's queue is momentarily full: try again later, don't drop */
const busy = (e: unknown) => e instanceof Error && e.message.includes('429')

let flushing: Promise<void> | null = null
/** Send queued messages in order; stops at the first one that still cannot
 *  get through. Safe to call often: concurrent callers share one pass. */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing
  if (!outbox.length) return Promise.resolve()
  flushing = (async () => {
    while (outbox.length) {
      const head = outbox[0]
      try {
        await postCommand(head)
      } catch (e) {
        if (unreachable(e) || busy(e)) return
        // refused (e.g. that session is gone): drop it rather than block the rest
      }
      // a discard during the await emptied the queue: don't drop a newer one
      if (outbox[0] === head) outbox.shift()
      notifyOutbox()
    }
  })().finally(() => { flushing = null })
  return flushing
}

export async function sendCommand(cmd: CommandInput): Promise<void> {
  if (QUEUEABLE.has(cmd.kind) && !cmd.cid) cmd = { ...cmd, cid: newCid() }
  // keep order: once something is queued, later messages queue behind it
  if (QUEUEABLE.has(cmd.kind) && outbox.length) {
    outbox.push(cmd)
    notifyOutbox()
    void flushOutbox()
    return
  }
  try {
    await postCommand(cmd)
  } catch (e) {
    if (!QUEUEABLE.has(cmd.kind) || !(unreachable(e) || busy(e))) throw e
    outbox.push(cmd)
    notifyOutbox()
  }
}

/** Request/response bridge: queue an rpc command (fs/git browsing), then wait
 *  for the desktop's answer. The pickup is a long-poll the server holds open
 *  until the answer lands, so a folder tap costs one round trip, not a
 *  polling interval. (An older desktop ignores `wait` and answers at once;
 *  the short pause keeps that case from spinning.) */
export async function rpc<T>(kind: string, payload: string, timeoutMs = 15_000): Promise<T> {
  const id = `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  await sendCommand({ kind, id, text: payload })
  const deadline = Date.now() + timeoutMs
  let first = true
  while (Date.now() < deadline) {
    if (!first) await new Promise(r => setTimeout(r, 150))
    first = false
    const wait = String(Math.max(0, Math.min(8_000, deadline - Date.now())))
    const res = await fetch(apiUrl('/api/rpc', { d: deviceToken(), id, wait }))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { ready: boolean; json?: T & { error?: string } }
    if (body.ready && body.json) {
      if (body.json.error) throw new Error(body.json.error)
      return body.json
    }
  }
  throw new Error('the desktop did not answer in time')
}

const MAX_IMAGE_EDGE = 2048

/** Decode any image the browser can show (incl. iPhone HEIC in Safari) and
 *  re-encode it as a JPEG no larger than MAX_IMAGE_EDGE on its long side: a
 *  12MP photo drops from several MB to a few hundred KB, which matters on a
 *  phone uplink and is all an agent needs to read a screenshot or sketch. */
async function toJpeg(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b ?? file), 'image/jpeg', 0.85))
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Send a photo to the desktop; resolves to the absolute path it was saved
 *  at, which the composer drops into the message for the agent to read. */
export async function uploadImage(file: Blob): Promise<string> {
  let body = file
  try { body = await toJpeg(file) } catch { /* undecodable here: let the desktop sniff the original */ }
  const res = await fetch(apiUrl('/api/upload', { d: deviceToken() }), { method: 'POST', body })
  const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string }
  if (!res.ok || !json.path) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json.path
}

// ---------------------------------------------------------------- push

export interface PushPrefs { needs: boolean; done: boolean }
export type PushSupport = 'ok' | 'insecure' | 'ios-browser' | 'unsupported'

/** Can this browser take push alerts from here? Push needs a secure context
 *  (the HTTPS tunnel link, not the plain LAN one), and on iOS it only exists
 *  inside a home-screen web app. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches
  if (!window.isSecureContext) return 'insecure'
  if (ios && !standalone) return 'ios-browser'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  return 'ok'
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface PushServerState { key: string; endpoint: string | null; prefs: PushPrefs }

async function pushServerState(): Promise<PushServerState> {
  return await getJson<PushServerState>('/api/push/key', { d: deviceToken() })
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return await navigator.serviceWorker.ready
}

/** Is push on for this device, and with which preferences? */
export async function pushStatus(): Promise<{ on: boolean; prefs: PushPrefs }> {
  const st = await pushServerState()
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return { on: false, prefs: st.prefs }
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return { on: Boolean(sub && st.endpoint === sub.endpoint), prefs: st.prefs }
}

/** Ask permission (must run from a tap), subscribe with the desktop's VAPID
 *  key, and register the subscription for this paired device. A key change
 *  (desktop store reset) replaces the stale subscription. */
export async function enablePush(prefs: PushPrefs): Promise<void> {
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked for this site')
  }
  const { key } = await pushServerState()
  const reg = await registration()
  const appKey = b64uToBytes(key)
  let sub = await reg.pushManager.getSubscription()
  const current = sub?.options.applicationServerKey
  if (sub && current && !sameBytes(new Uint8Array(current), appKey)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  await postJson('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys, prefs }, { d: deviceToken() })
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export async function disablePush(): Promise<void> {
  await postJson('/api/push/unsubscribe', {}, { d: deviceToken() })
  const reg = await navigator.serviceWorker.getRegistration('/')
  await (await reg?.pushManager.getSubscription())?.unsubscribe()
}

/** Re-register an existing subscription silently on launch (the desktop may
 *  have dropped it: unpair/re-pair, a reset store). Never prompts. */
export async function resyncPush(): Promise<void> {
  if (pushSupport() !== 'ok' || Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.getRegistration('/')
  if (!(await reg?.pushManager.getSubscription())) return
  const st = await pushServerState()
  await enablePush(st.prefs)
}

/** "Companion on screen" heartbeat: the desktop holds alerts while it is. */
export function reportPresence(visible: boolean): void {
  void fetch(apiUrl('/api/presence', { d: deviceToken(), v: visible ? '1' : '0' }), { keepalive: true }).catch(() => {})
}

export type { RemoteSnapshot }
