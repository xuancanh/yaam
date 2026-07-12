// Sandbox adapter: ask the backend for the OS write-sandbox wrapper prefix a
// local session command runs under (sandbox-exec on macOS, bwrap on Linux).
// Desktop only — remote machine sessions build their bwrap prefix in the
// frontend instead (domains/session/sandbox).
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

/** Build the sandbox wrapper prefix for a session; rejects when the sandbox
 *  can't be applied (unsupported OS, missing tooling, bad cwd) — fail closed. */
export async function sandboxWrapper(id: string, cwd: string, extraPaths: string[], denyNetwork: boolean): Promise<string> {
  if (!isTauri) throw new Error('sandboxing requires the desktop app')
  return await invoke<string>('sandbox_wrapper', { id, cwd, extraPaths, denyNetwork })
}
