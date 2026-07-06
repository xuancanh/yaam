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
  /** reconnect command rebuilt with the currently running YAAM binary */
  attach: string
}

/** Ensure the detached host (reattach a live one, relaunch a dead one);
 *  returns the attach command to run as the session. An empty command reuses
 *  the host's stored spec. */
export async function detachedSpawn(id: string, command: string, cwd?: string, commandShell?: string, rows?: number, cols?: number): Promise<string> {
  if (!isTauri) throw new Error('detached sessions require the desktop app')
  return await invoke<string>('detached_spawn', { id, command, cwd: cwd ?? null, commandShell: commandShell ?? null, rows: rows ?? null, cols: cols ?? null })
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
