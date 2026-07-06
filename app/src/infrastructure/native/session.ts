// Native PTY session adapter: spawn/write/resize/kill live terminal processes,
// CLI resume-id detection, PTY output/exit event subscriptions, and the app-close
// veto handshake. Browser build: spawn/exec throw, the rest are no-ops.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from './base'

export interface SessionData {
  id: string
  /** raw PTY bytes, decoded from base64 */
  bytes: Uint8Array
}

export interface SessionExit {
  id: string
  code: number | null
}

/** Ask Tauri to launch a command or direct terminal shell in a real PTY. */
export async function spawnSession(id: string, command: string, cwd?: string, rows?: number, cols?: number, terminalShell?: string, commandShell?: string): Promise<void> {
  if (!isTauri) throw new Error('Real sessions require the desktop app')
  await invoke('spawn_session', { id, command, terminalShell: terminalShell || null, commandShell: commandShell || null, cwd: cwd || null, rows: rows ?? null, cols: cols ?? null })
}

/** Write raw input bytes to a live native PTY. */
export async function writeSession(id: string, data: string): Promise<void> {
  if (!isTauri) return
  await invoke('write_session', { id, data })
}

/** Resize a live native PTY to match its xterm viewport. */
export async function resizeSession(id: string, rows: number, cols: number): Promise<void> {
  if (!isTauri) return
  await invoke('resize_session', { id, rows, cols }).catch(() => {})
}

/** Discover the CLI conversation id created after a YAAM session launched.
 *  `exclude` holds ids already claimed by other live sessions so concurrent
 *  sessions (esp. codex/opencode, whose stores aren't cwd-scoped) don't collide. */
export async function detectCliSession(kind: string, cwd: string | undefined, sinceMs: number, exclude: string[] = []): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('detect_cli_session', { kind, cwd: cwd || null, sinceMs, exclude })
}

/** Return native PTY ids that are still owned by the backend. */
export async function liveSessions(): Promise<string[]> {
  if (!isTauri) return []
  return await invoke<string[]>('live_sessions')
}

/** Terminate and unregister one native PTY process. */
export async function killSession(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('kill_session', { id })
}

/** Decode base64 PTY event payloads without assuming browser text encoding. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Subscribe to decoded PTY output and return an unsubscribe function. */
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

/** Subscribe to native process-exit events and return an unsubscribe function. */
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

/** Subscribe to the backend's close-requested event (the OS close was vetoed so
 *  the app can flush first). No-op outside Tauri. Returns an unsubscribe fn. */
export function onCloseRequested(cb: () => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen('close-requested', () => cb()).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}

/** Force-close the app window (bypasses the CloseRequested veto). */
export async function destroyWindow(): Promise<void> {
  if (!isTauri) return
  await getCurrentWindow().destroy()
}
