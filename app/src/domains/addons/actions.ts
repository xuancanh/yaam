// Addons-domain actions: open/toggle/grant, install (file/folder/URL), AI
// generate, per-addon customization chat, RPC bridge, meta edit, export, and
// remove. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Addon, AddonPermission, AppState } from '../../core/types'
import { buildCfg, hasCreds } from '../../master'
import { realPackageIoPort } from './ports'
import type { PackageIoPort } from './ports'
import { dispatchAddonRpc, exportAddonPackage, loadAddonFolder } from '../../core/addons'
import type { AddonApi } from '../../core/addons'
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
  generateAddon: (prompt: string) => Promise<string>
  installAddonFromUrl: (url: string) => void
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
          installPackage(json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromFolder: () => {
      void (async () => {
        try {
          const dir = await io.pickFolder()
          if (!dir) return
          let manifest: string | null = null
          for (const cand of ['addon.yaml', 'addon.yml', 'addon.json']) {
            try {
              manifest = await io.readTextFile(`${dir}/${cand}`)
              break
            } catch { /* try the next manifest name */ }
          }
          if (!manifest) throw new Error('no addon.yaml / addon.yml / addon.json in that folder')
          const json = await loadAddonFolder(manifest, rel => io.readTextFile(`${dir}/${rel}`))
          installPackage(json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromUrl: url => {
      void (async () => {
        try {
          // registries can be local: non-http entries are filesystem paths
          const json = /^https?:\/\//.test(url) ? await io.httpGetText(url) : await io.readTextFile(url)
          installPackage(json, /^https?:\/\//.test(url) ? 'url' : 'file')
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
        installPackage(json, 'master')
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
