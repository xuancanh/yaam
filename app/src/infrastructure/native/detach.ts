// Detachable sessions adapter: the PTY lives in a daemonized host process the
// app talks to via a per-session unix socket. Sessions survive app quits; the
// app reconnects through the returned attach command.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

export interface DetachedInfo {
  id: string
  command: string
  cwd: string | null
  running: boolean
}

/** Start the detached host; returns the attach command to run as the session
 *  (also its natural resume/reconnect command). */
export async function detachedSpawn(id: string, command: string, cwd?: string): Promise<string> {
  if (!isTauri) throw new Error('detached sessions require the desktop app')
  return await invoke<string>('detached_spawn', { id, command, cwd: cwd ?? null, rows: null, cols: null })
}

/** Detached sessions still alive on this machine. */
export async function detachedList(): Promise<DetachedInfo[]> {
  if (!isTauri) return []
  return await invoke<DetachedInfo[]>('detached_list')
}

/** End a detached session for real (the attach client alone only detaches). */
export async function detachedKill(id: string): Promise<void> {
  if (!isTauri) return
  await invoke('detached_kill', { id })
}
