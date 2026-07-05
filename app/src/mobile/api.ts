// Mobile API layer: relative-path fetches (so the app works on a raw LAN IP,
// a Tailscale/WireGuard address, or behind a Cloudflare Tunnel alike) carrying
// the URL token from the link plus the per-device token minted by the desktop
// pairing approval. The device identity/token persist in localStorage.
import type { RemoteSnapshot } from '../domains/remote/snapshot'

const DEVICE_ID_KEY = 'yaam-remote-device-id'
const DEVICE_TOKEN_KEY = 'yaam-remote-device-token'

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
export async function pairingStatus(): Promise<'pending' | 'paired' | 'unknown'> {
  const res = await getJson<{ status: string; token?: string }>('/api/pair/status', { device: deviceId() })
  if (res.status === 'paired' && res.token) storeDeviceToken(res.token)
  return (res.status as 'pending' | 'paired' | 'unknown') ?? 'unknown'
}

export async function fetchState(): Promise<RemoteSnapshot> {
  return await getJson<RemoteSnapshot>('/api/state', { d: deviceToken() })
}

export interface CommandInput {
  kind: string
  id: string
  agent_id?: string
  text?: string
  ok?: boolean
}

export async function sendCommand(cmd: CommandInput): Promise<void> {
  await postJson('/api/command', { agent_id: '', text: '', ok: false, ...cmd }, { d: deviceToken() })
}

export type { RemoteSnapshot }
