// Addons-domain actions: open/toggle/grant, install (file/folder/URL), AI
// generate, per-addon customization chat, RPC bridge, meta edit, export, and
// remove. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Addon, AddonPermission, AppState } from '../../core/types'
import { buildCfg, hasCreds } from '../../master'
import { realPackageIoPort } from './ports'
import type { PackageIoPort } from './ports'
import { appCompat, dispatchAddonRpc, exportAddonPackage, loadAddonFolder, parseAddonPackage } from '../../core/addons'
import type { AddonApi } from '../../core/addons'
import type { AddonInstallPreview } from './slice'
import { generateAddonPackage } from './addon-gen'

export interface AddonsActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  installPackage: (json: string, source: Addon['source']) => void
  sendAddonChat: (id: string, text: string) => void
  makeAddonApi: (addonId: string) => AddonApi
  /** tear down an addon's runtime state (agent registries + editor history) on removal */
  disposeAddon: (addonId: string) => void
  /** file/dialog/http capability for package install/export; defaults to real IPC */
  io?: PackageIoPort
}

export interface AddonsActions {
  openAddon: (id: string) => void
  removeAddon: (id: string) => void
  toggleAddon: (id: string) => void
  toggleAddonGrant: (id: string, perm: AddonPermission) => void
  /** install a package from an in-memory JSON string (plugin hook translation) */
  installAddonJson: (json: string) => void
  installAddonFromFile: () => void
  installAddonFromFolder: () => void
  /** install a folder AND keep watching it — edits hot-reinstall the addon */
  installAddonForDev: () => void
  /** set/clear the watched dev folder on an installed addon */
  setAddonDevPath: (id: string, devPath: string | null) => void
  generateAddon: (prompt: string) => Promise<string>
  installAddonFromUrl: (url: string) => void
  /** commit the currently-staged install (after the permission preview) */
  confirmAddonInstall: () => void
  /** dismiss the permission preview without installing */
  cancelAddonInstall: () => void
  exportAddon: (id: string) => void
  sendAddonChat: (id: string, text: string) => void
  addonRpc: (addonId: string, method: string, args: unknown[]) => Promise<unknown>
  updateAddonMeta: (id: string, patch: Partial<Pick<Addon, 'name' | 'version' | 'icon' | 'desc' | 'author'>>) => void
}

export function useAddonsActions(ctx: AddonsActionsCtx): AddonsActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createAddonsActions(ctx), [ctx.dispatch, ctx.stateRef, ctx.flash, ctx.installPackage, ctx.io, ctx])
}

/** The addon actions as a plain factory (no React), for unit testing. */
export function createAddonsActions(ctx: AddonsActionsCtx): AddonsActions {
  const { dispatch, stateRef, flash, installPackage } = ctx
  const io = ctx.io ?? realPackageIoPort
  return {
    openAddon: id => dispatch(s => ({ ...s, view: 'addon', activeAddon: id })),

    toggleAddon: id => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    })),

    toggleAddonGrant: (id, perm) => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => a.id === id
        ? { ...a, granted: a.granted.includes(perm) ? a.granted.filter(g => g !== perm) : a.granted.concat([perm]) }
        : a),
    })),

    installAddonJson: json => {
      installPackage(json, 'registry')
    },

    installAddonFromFile: () => {
      void (async () => {
        try {
          const path = await io.pickFile()
          if (!path) return
          const json = await io.readTextFile(path)
          stagePreview(ctx, json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromFolder: () => { void installFolder(ctx, io, false) },

    installAddonForDev: () => { void installFolder(ctx, io, true) },

    confirmAddonInstall: () => {
      const pending = stateRef.current.addonInstall
      dispatch(s => ({ ...s, addonInstall: null }))
      if (pending) installPackage(pending.json, pending.source)
    },

    cancelAddonInstall: () => dispatch(s => ({ ...s, addonInstall: null })),

    setAddonDevPath: (id, devPath) => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => (a.id === id ? { ...a, devPath: devPath ?? undefined } : a)),
    })),

    installAddonFromUrl: url => {
      void (async () => {
        try {
          // registries can be local: non-http entries are filesystem paths
          const isHttp = /^https?:\/\//.test(url)
          const json = isHttp ? await io.httpGetText(url) : await io.readTextFile(url)
          stagePreview(ctx, json, isHttp ? 'url' : 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    generateAddon: async prompt => {
      const st = stateRef.current.settings
      if (!(st.masterEnabled && hasCreds(st))) return 'No brain configured — enable LLM Master in Settings first.'
      try {
        const json = await generateAddonPackage(buildCfg(st), prompt)
        stagePreview(ctx, json, 'master')
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },

    sendAddonChat: (id, text) => { ctx.sendAddonChat(id, text) },

    addonRpc: (addonId, method, args) => dispatchAddonRpc(ctx.makeAddonApi(addonId), method, args),

    updateAddonMeta: (id, patch) => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => (a.id === id ? { ...a, ...patch } : a)),
    })),

    exportAddon: id => {
      void (async () => {
        const addon = stateRef.current.addons.find(a => a.id === id)
        if (!addon) return
        try {
          const path = await io.pickSavePath(`${addon.name.replace(/[^a-z0-9-]/gi, '-')}.yaam.json`)
          if (!path) return
          await io.writeTextFile(path, exportAddonPackage(addon))
          flash(`Exported ${addon.name}`)
        } catch (e) {
          flash(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    removeAddon: id => {
      ctx.disposeAddon(id) // cancel any in-flight agent turn + drop its registries + editor history
      dispatch(s => {
        const addonStorage = { ...s.addonStorage }
        delete addonStorage[id]
        const addonChats = { ...s.addonChats }
        delete addonChats[id]
        return {
          ...s,
          addons: s.addons.filter(a => a.id !== id),
          addonStorage, addonChats,
          view: s.activeAddon === id ? 'workspace' : s.view,
          activeAddon: s.activeAddon === id ? null : s.activeAddon,
        }
      })
    },
  }
}

/** Stage a package for the permission-preview modal. Parses the JSON (reporting
 *  a readable error on failure) and records the metadata the modal renders plus
 *  the app-version compatibility verdict; the raw JSON is committed on confirm. */
function stagePreview(ctx: AddonsActionsCtx, json: string, source: Addon['source']): void {
  let parsed: ReturnType<typeof parseAddonPackage>
  try { parsed = parseAddonPackage(json) } catch (e) {
    ctx.flash(`Invalid package: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const existing = ctx.stateRef.current.addons.find(a => a.name === parsed.name)
  const preview: AddonInstallPreview = {
    json, source,
    name: parsed.name, version: parsed.version, icon: parsed.icon,
    desc: parsed.desc, author: parsed.author, minAppVersion: parsed.minAppVersion,
    permissions: parsed.permissions,
    hosts: parsed.hosts, secrets: parsed.secrets,
    hasView: !!parsed.html, toolCount: parsed.tools?.length ?? 0,
    hookNames: parsed.hooks ? Object.entries(parsed.hooks).filter(([, v]) => v).map(([k]) => k) : [],
    hasAgent: !!parsed.agent,
    update: existing ? { fromVersion: existing.version } : undefined,
    compat: appCompat(parsed.minAppVersion),
  }
  ctx.dispatch(s => ({ ...s, addonInstall: preview }))
}

/** Pick + load + install a folder-format addon; `dev` keeps the folder watched.
 *  Dev installs commit straight away (tight edit loop, still version-checked);
 *  a plain folder install goes through the permission-preview modal. */
async function installFolder(ctx: AddonsActionsCtx, io: PackageIoPort, dev: boolean): Promise<void> {
  const { dispatch, stateRef, flash, installPackage } = ctx
  try {
    const dir = await io.pickFolder()
    if (!dir) return
    let manifest: string | null = null
    for (const cand of ['addon.yaml', 'addon.yml', 'addon.json']) {
      try {
        manifest = await io.readTextFile(`${dir}/${cand}`, dir)
        break
      } catch { /* try the next manifest name */ }
    }
    if (!manifest) throw new Error('no addon.yaml / addon.yml / addon.json in that folder')
    const json = await loadAddonFolder(manifest, rel => io.readTextFile(`${dir}/${rel}`, dir))
    if (!dev) { stagePreview(ctx, json, 'file'); return }
    installPackage(json, 'file')
    if (dev) {
      // installPackage upserts by package name — pin the watched folder on it
      const name = String((JSON.parse(json) as { name?: unknown }).name ?? '')
      const installed = stateRef.current.addons.find(a => a.name === name)
      if (installed) {
        dispatch(s => ({
          ...s,
          addons: s.addons.map(a => (a.id === installed.id ? { ...a, devPath: dir } : a)),
        }))
        flash(`Watching ${dir} — edits reload the addon`)
      }
    }
  } catch (e) {
    flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
