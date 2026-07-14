// Bridge for the rich HTML preview scheme. The backend stashes a rendered
// document and serves it from a custom URI scheme (yaampreview://localhost/<id>)
// so the iframe gets its own policy container instead of inheriting the app's
// strict CSP — see src-tauri/src/domains/preview.rs. In a plain browser build
// there is no scheme, so callers fall back to srcDoc.
import { isTauri } from './base'

/** Stash `html` and return the id + the loadable custom-scheme URL, or null in
 *  a browser build (caller then uses srcDoc). */
export async function previewStash(html: string): Promise<{ id: string; url: string } | null> {
  if (!isTauri) return null
  const { invoke, convertFileSrc } = await import('@tauri-apps/api/core')
  const id = await invoke<string>('preview_stash', { html })
  return { id, url: convertFileSrc(id, 'yaampreview') }
}

/** Drop a stashed preview when its viewer closes or reloads. */
export async function previewClear(id: string): Promise<void> {
  if (!isTauri) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('preview_clear', { id }).catch(() => {})
}
