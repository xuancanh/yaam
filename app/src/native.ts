// Bridge to the Tauri backend. Falls back to no-ops when running in a plain
// browser (e.g. `npm run dev` opened directly) so the simulated agents still work.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface SessionOutput {
  id: string
  stream: 'out' | 'err' | 'sys'
  line: string
}

export interface SessionExit {
  id: string
  code: number | null
}

export async function spawnSession(id: string, command: string, args: string[], cwd?: string): Promise<void> {
  if (!isTauri) throw new Error('Real sessions require the desktop app')
  await invoke('spawn_session', { id, command, args, cwd: cwd || null })
}

export async function writeSession(id: string, data: string): Promise<void> {
  if (!isTauri) return
  await invoke('write_session', { id, data })
}

export async function killSession(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('kill_session', { id })
}

export function onSessionOutput(cb: (e: SessionOutput) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<SessionOutput>('session-output', e => cb(e.payload)).then(fn => {
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
