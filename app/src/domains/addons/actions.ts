// Addons-domain actions: open/toggle/grant, install (file/folder/URL), AI
// generate, per-addon customization chat, RPC bridge, meta edit, export, and
// remove. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Addon, AppState } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import * as native from '../../core/native'
import { dispatchAddonRpc, exportAddonPackage, loadAddonFolder } from '../../core/addons'
import type { AddonApi } from '../../core/addons'
import { generateAddonPackage } from './addon-gen'
import type { ConductorActions } from '../../store'

export interface AddonsActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  installPackage: (json: string, source: Addon['source']) => void
  sendAddonChat: (id: string, text: string) => void
  makeAddonApi: (addonId: string) => AddonApi
  addonAgentHistories: MutableRefObject<Map<string, ApiMessage[]>>
  addonEditorHistories: MutableRefObject<Map<string, ApiMessage[]>>
}

type AddonsActions = Pick<ConductorActions,
  | 'openAddon' | 'toggleAddon' | 'toggleAddonGrant' | 'installAddonFromFile' | 'installAddonFromFolder'
  | 'installAddonFromUrl' | 'generateAddon' | 'sendAddonChat' | 'addonRpc' | 'updateAddonMeta'
  | 'exportAddon' | 'removeAddon'>

export function useAddonsActions(ctx: AddonsActionsCtx): AddonsActions {
  const { dispatch, stateRef, flash, installPackage } = ctx
  return useMemo(() => ({
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

    installAddonFromFile: () => {
      void (async () => {
        try {
          const path = await native.pickFile()
          if (!path) return
          const json = await native.readTextFile(path)
          installPackage(json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromFolder: () => {
      void (async () => {
        try {
          const dir = await native.pickFolder()
          if (!dir) return
          let manifest: string | null = null
          for (const cand of ['addon.yaml', 'addon.yml', 'addon.json']) {
            try {
              manifest = await native.readTextFile(`${dir}/${cand}`)
              break
            } catch { /* try the next manifest name */ }
          }
          if (!manifest) throw new Error('no addon.yaml / addon.yml / addon.json in that folder')
          const json = await loadAddonFolder(manifest, rel => native.readTextFile(`${dir}/${rel}`))
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
          const json = /^https?:\/\//.test(url) ? await native.httpGetText(url) : await native.readTextFile(url)
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
          const path = await native.pickSavePath(`${addon.name.replace(/[^a-z0-9-]/gi, '-')}.yaam.json`)
          if (!path) return
          await native.writeTextFile(path, exportAddonPackage(addon))
          flash(`Exported ${addon.name}`)
        } catch (e) {
          flash(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    removeAddon: id => {
      ctx.addonAgentHistories.current.delete(id)
      ctx.addonEditorHistories.current.delete(id)
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
  }), [dispatch, stateRef, flash, installPackage, ctx])
}
