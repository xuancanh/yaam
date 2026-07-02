// Bridge to the Tauri backend. Falls back to no-ops when running in a plain
// browser (e.g. `npm run dev` opened directly) so the simulated agents still work.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface SessionData {
  id: string
  /** raw PTY bytes, decoded from base64 */
  bytes: Uint8Array
}

export interface SessionExit {
  id: string
  code: number | null
}

export async function spawnSession(id: string, command: string, cwd?: string, rows?: number, cols?: number): Promise<void> {
  if (!isTauri) throw new Error('Real sessions require the desktop app')
  await invoke('spawn_session', { id, command, cwd: cwd || null, rows: rows ?? null, cols: cols ?? null })
}

export async function writeSession(id: string, data: string): Promise<void> {
  if (!isTauri) return
  await invoke('write_session', { id, data })
}

export async function resizeSession(id: string, rows: number, cols: number): Promise<void> {
  if (!isTauri) return
  await invoke('resize_session', { id, rows, cols }).catch(() => {})
}

export async function killSession(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('kill_session', { id })
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function onSessionData(cb: (e: SessionData) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<{ id: string; data: string }>('session-data', e => {
    cb({ id: e.payload.id, bytes: b64ToBytes(e.payload.data) })
  }).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

export function onSessionExit(cb: (e: SessionExit) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<SessionExit>('session-exit', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ directory: true, multiple: false, defaultPath: defaultPath || undefined })
  return typeof picked === 'string' ? picked : null
}

export async function gitDiff(cwd: string): Promise<string> {
  if (!isTauri) throw new Error('git diff requires the desktop app')
  return await invoke<string>('git_diff', { cwd })
}

export async function saveStateFile(json: string): Promise<void> {
  if (!isTauri) {
    localStorage.setItem('conductor-state', json)
    return
  }
  await invoke('save_state', { json })
}

export async function loadStateFile(): Promise<string | null> {
  if (!isTauri) return localStorage.getItem('conductor-state')
  return await invoke<string | null>('load_state')
}
