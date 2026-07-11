// Dev-install folder watcher. An addon installed "for development" keeps its
// source folder path (Addon.devPath); this watcher polls those folders and,
// when the loaded package JSON changes, re-installs it in place — same upgrade
// path as a manual reinstall (grants intersected, storage kept), and the view
// iframe remounts because createdAt changes. Polling (not fs events) keeps it
// dependency-free and covers editors that write via rename.
import type { MutableRefObject } from 'react'
import type { Addon, AppState } from '../../core/types'
import { loadAddonFolder } from '../../core/addons'

export interface DevWatchCtx {
  stateRef: MutableRefObject<AppState>
  /** confined text read (root pins folder-package refs inside devPath) */
  readTextFile: (path: string, root?: string) => Promise<string>
  installPackage: (json: string, source: Addon['source']) => void
  flash: (t: string) => void
  logEvent: (text: string) => void
  intervalMs?: number
  clock?: Pick<typeof globalThis, 'setInterval' | 'clearInterval'>
}

export interface DevAddonWatcher {
  start: () => void
  dispose: () => void
  /** one poll pass (exposed for tests) */
  tick: () => Promise<void>
}

const MANIFEST_NAMES = ['addon.yaml', 'addon.yml', 'addon.json']

/** Load a folder-format addon exactly like the install action does. */
export async function loadDevFolder(readTextFile: DevWatchCtx['readTextFile'], dir: string): Promise<string> {
  let manifest: string | null = null
  for (const cand of MANIFEST_NAMES) {
    try {
      manifest = await readTextFile(`${dir}/${cand}`, dir)
      break
    } catch { /* try the next manifest name */ }
  }
  if (!manifest) throw new Error(`no ${MANIFEST_NAMES.join(' / ')} in ${dir}`)
  return await loadAddonFolder(manifest, rel => readTextFile(`${dir}/${rel}`, dir))
}

export function createDevAddonWatcher(ctx: DevWatchCtx): DevAddonWatcher {
  const clock = ctx.clock ?? globalThis
  const intervalMs = ctx.intervalMs ?? 2000
  // addon id → last loaded package JSON (baseline seeded on the first tick,
  // so a reload only fires on a change observed while the app is running)
  const lastJson = new Map<string, string>()
  const lastError = new Map<string, string>()
  let timer: ReturnType<typeof globalThis.setInterval> | undefined
  let busy = false

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const watched = ctx.stateRef.current.addons.filter(a => a.devPath && a.enabled)
      for (const id of [...lastJson.keys()]) {
        if (!watched.some(a => a.id === id)) { lastJson.delete(id); lastError.delete(id) }
      }
      for (const a of watched) {
        try {
          const json = await loadDevFolder(ctx.readTextFile, a.devPath as string)
          lastError.delete(a.id)
          const prev = lastJson.get(a.id)
          lastJson.set(a.id, json)
          if (prev !== undefined && prev !== json) {
            ctx.installPackage(json, a.source)
            ctx.logEvent(`dev-reloaded addon “${a.name.slice(0, 40)}” from ${a.devPath}`)
            ctx.flash(`↻ ${a.name.slice(0, 40)} reloaded`)
          }
        } catch (e) {
          // surface each distinct failure once, not every 2s
          const msg = e instanceof Error ? e.message : String(e)
          if (lastError.get(a.id) !== msg) {
            lastError.set(a.id, msg)
            ctx.flash(`dev reload failed: ${msg.slice(0, 80)}`)
          }
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    tick,
    start() { timer ??= clock.setInterval(() => { void tick() }, intervalMs) },
    dispose() {
      if (timer !== undefined) clock.clearInterval(timer)
      timer = undefined
      lastJson.clear()
      lastError.clear()
    },
  }
}
