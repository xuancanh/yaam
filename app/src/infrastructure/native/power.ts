// Keep-awake bridge: the backend holds/releases the macOS idle-sleep
// assertion (a caffeinate child tied to our pid — see power.rs). Browser
// builds no-op.
import { isTauri } from './base'

export async function keepAwakeSet(on: boolean): Promise<void> {
  if (!isTauri) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('keep_awake_set', { on })
}
