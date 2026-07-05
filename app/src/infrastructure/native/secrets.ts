// OS keychain adapter for credentials. In the browser build there is no
// keychain, so these resolve to a no-op / null — secrets then stay in the
// localStorage state (unchanged pre-keychain behavior) rather than being lost.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

/** Store a secret in the OS keychain (empty value deletes it). */
export async function secretSet(account: string, value: string): Promise<void> {
  if (!isTauri) return
  await invoke('secret_set', { account, value })
}

/** Read a secret from the OS keychain, or null if absent/unavailable. */
export async function secretGet(account: string): Promise<string | null> {
  if (!isTauri) return null
  return await invoke<string | null>('secret_get', { account })
}

/** Delete a secret from the OS keychain. */
export async function secretDelete(account: string): Promise<void> {
  if (!isTauri) return
  await invoke('secret_delete', { account })
}
