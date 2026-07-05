// OS notification adapter (tauri-plugin-notification). Best-effort: silently
// no-ops in browser builds or when the user denied the permission.
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { isTauri } from './base'

let granted: boolean | null = null

/** Show a native desktop notification. */
export async function osNotify(title: string, body: string): Promise<void> {
  if (!isTauri) return
  try {
    if (granted === null) {
      granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
    }
    if (granted) sendNotification({ title, body: body.slice(0, 240) })
  } catch {
    // notifications are decoration, never an error path
  }
}
