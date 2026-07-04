// Bridge to the Tauri backend. Falls back to no-ops when running in a plain
// browser (e.g. `npm run dev` opened directly) so the simulated agents still work.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

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

export async function detectCliSession(kind: string, cwd: string | undefined, sinceMs: number): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('detect_cli_session', { kind, cwd: cwd || null, sinceMs })
}

export async function liveSessions(): Promise<string[]> {
  if (!isTauri) return []
  return await invoke<string[]>('live_sessions')
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

export async function httpGetText(url: string): Promise<string> {
  const res = await (isTauri ? tauriFetch : fetch)(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

export async function pickFile(): Promise<string | null> {
  if (!isTauri) return null
  const picked = await openDialog({ multiple: false, filters: [{ name: 'YAAM addon', extensions: ['json'] }] })
  return typeof picked === 'string' ? picked : null
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null
  return await saveDialog({ defaultPath: defaultName, filters: [{ name: 'YAAM addon', extensions: ['json'] }] })
}

export async function readTextFile(path: string): Promise<string> {
  return await invoke<string>('read_text_file', { path })
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await invoke('write_text_file', { path, contents })
}

export interface DirEntryInfo {
  name: string
  path: string
  isDir: boolean
}

export async function listDir(path: string): Promise<DirEntryInfo[]> {
  if (!isTauri) return []
  const raw = await invoke<{ name: string; path: string; is_dir: boolean }[]>('list_dir', { path })
  return raw.map(e => ({ name: e.name, path: e.path, isDir: e.is_dir }))
}

export interface GitStatusResult {
  root: string
  files: { path: string; status: string }[]
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<GitStatusResult>('git_status', { cwd })
}

export async function gitFileDiff(cwd: string, path: string): Promise<string> {
  if (!isTauri) throw new Error('git requires the desktop app')
  return await invoke<string>('git_file_diff', { cwd, path })
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
