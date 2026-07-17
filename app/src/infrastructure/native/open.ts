// External-link opener: hands http(s) URLs to the OS default browser via the
// scheme-restricted Rust command (terminal output is untrusted, so file:/app
// schemes are rejected backend-side too). Browser build: a plain new tab.
import { isTauri } from './base'

/** Open an http(s) URL in the user's default browser. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('open_external', { url }).catch(() => {})
}
