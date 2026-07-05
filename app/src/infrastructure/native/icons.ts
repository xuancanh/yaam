// System file-icon adapter: the OS's own icon (macOS Finder / NSWorkspace)
// for a path, as a base64 PNG. Errors on other platforms — callers fall back
// to their glyph sets.
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './base'

/** Base64 PNG of the OS icon for `path` (macOS only; rejects elsewhere). */
export async function fileIcon(path: string): Promise<string> {
  if (!isTauri) throw new Error('system file icons require the desktop app')
  return await invoke<string>('file_icon', { path })
}
