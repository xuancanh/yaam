// OTA update adapter (tauri-plugin-updater). The endpoint, public key, and
// artifact verification live in tauri.conf.json / the Rust process — this is
// only the check/install choreography. Best-effort: resolves null in browser
// builds. Plugin modules load lazily so non-Tauri bundles never pull them in.
import { isTauri } from './base'

export interface AppUpdate {
  version: string
  notes?: string
  /** Download, verify, swap the app bundle, then relaunch into the new build. */
  install: (onProgress?: (percent: number | null) => void) => Promise<void>
}

/** Ask the release endpoint whether a newer build exists. */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauri) return null
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) return null
  return {
    version: update.version,
    notes: update.body,
    install: async onProgress => {
      let total = 0
      let received = 0
      await update.downloadAndInstall(e => {
        if (e.event === 'Started') total = e.data.contentLength ?? 0
        else if (e.event === 'Progress') {
          received += e.data.chunkLength
          onProgress?.(total ? Math.min(99, Math.round((received / total) * 100)) : null)
        } else if (e.event === 'Finished') onProgress?.(100)
      })
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    },
  }
}
