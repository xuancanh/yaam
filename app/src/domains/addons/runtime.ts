// Addon runtime: the addon customization-chat editor turn and package install/
// upgrade. Extracted from the provider; owns nothing React-specific and operates
// on the shared store via dispatch plus the editor-history ref passed in ctx.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { Addon, AppState, EventType } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import { dispatch } from '../../core/store'
import { DANGEROUS_PERMISSIONS, appCompat, exportAddonPackage, parseAddonPackage } from '../../core/addons'
import { runAddonEditorTurn } from './addon-editor'
import { mkId } from '../../shared/id'

export interface AddonRuntimeCtx {
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  editorHistories: MutableRefObject<Map<string, ApiMessage[]>>
}

export interface AddonRuntime {
  /** run one addon customization-chat editor turn (may rewrite the addon). */
  sendAddonChat: (id: string, text: string) => Promise<void>
  /** validate + install or upgrade an addon package (preserving grants). */
  installPackage: (json: string, source: Addon['source']) => void
}

export function useAddonRuntime(ctx: AddonRuntimeCtx): AddonRuntime {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createAddonRuntime(ctx), [ctx.stateRef, ctx.flash, ctx.logEvent, ctx.editorHistories])
}

/** Plain (non-React) factory for the addon editor + install runtime. */
export function createAddonRuntime(ctx: AddonRuntimeCtx): AddonRuntime {
  const { stateRef, flash, logEvent, editorHistories } = ctx
  return {
    sendAddonChat: async (id, text) => {
      const st = stateRef.current.settings
      const addon = stateRef.current.addons.find(a => a.id === id)
      if (!addon) return
      dispatch(s2 => ({
        ...s2,
        addonChats: { ...s2.addonChats, [id]: (s2.addonChats[id] ?? []).concat([{ role: 'you', text }]) },
        addonChatBusy: id,
      }))
      // Append an editor reply to the addon's bounded customization history.
      const reply = (t: string) => dispatch(s2 => ({
        ...s2,
        addonChats: { ...s2.addonChats, [id]: (s2.addonChats[id] ?? []).concat([{ role: 'master', text: t }]) },
        addonChatBusy: s2.addonChatBusy === id ? null : s2.addonChatBusy,
      }))
      if (!(hasCreds(st) && st.masterEnabled)) {
        reply('The addon editor needs the LLM Master configured (Settings → Master Brain).')
        return
      }
      let history = editorHistories.current.get(id)
      if (!history) {
        history = []
        editorHistories.current.set(id, history)
      }
      // Validate and atomically replace the addon's editable package fields.
      const apply = (json: string): string => {
        try {
          const parsed = parseAddonPackage(json)
          dispatch(s2 => ({
            ...s2,
            addons: s2.addons.map(a => a.id === id
              ? { ...a, ...parsed, id, source: a.source, enabled: a.enabled, granted: a.granted.filter(g => parsed.permissions.includes(g)), createdAt: new Date().toLocaleString() }
              : a),
          }))
          logEvent('build', null, `Addon “${parsed.name}” updated via its chat (v${parsed.version})`)
          return `applied — the addon is now v${parsed.version}`
        } catch (e) {
          return `rejected: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      try {
        const current = stateRef.current.addons.find(a => a.id === id)
        const out = await runAddonEditorTurn(
          buildCfg(st), current ? exportAddonPackage(current) : '{}', history, text, apply)
        reply(out || '(updated)')
      } catch (e) {
        reply(`Editor error: ${e instanceof Error ? e.message : String(e)}`)
      }
    },

    installPackage: (json, source) => {
      const parsed = parseAddonPackage(json) // throws readable errors
      // final compatibility gate — guards every path (dev/master included), not
      // just the previewed ones. The UI blocks incompatible installs earlier.
      const compat = appCompat(parsed.minAppVersion)
      if (!compat.ok) {
        logEvent('build', null, `Blocked addon “${parsed.name}” v${parsed.version} — ${compat.reason}`)
        flash(`Can’t install ${parsed.name}: ${compat.reason}`)
        return
      }
      const existing = stateRef.current.addons.find(a => a.name === parsed.name)
      const addon: Addon = {
        ...parsed,
        id: existing?.id ?? mkId('ad'),
        // upgrades keep the user's grant choices (intersected with what's now
        // requested); fresh installs never auto-grant dangerous scopes — the
        // user enables them per-addon in Settings -> Addons
        granted: existing
          ? existing.granted.filter(g => parsed.permissions.includes(g))
          : parsed.permissions.filter(g => !DANGEROUS_PERMISSIONS.includes(g)),
        enabled: true,
        source,
        createdAt: new Date().toLocaleString(),
        // a dev-installed addon stays watched across hot reinstalls
        ...(existing?.devPath ? { devPath: existing.devPath } : {}),
      }
      dispatch(s2 => ({
        ...s2,
        addons: existing ? s2.addons.map(a => (a.id === existing.id ? addon : a)) : s2.addons.concat([addon]),
        ...(addon.html ? { view: 'addon' as const, activeAddon: addon.id } : {}),
      }))
      logEvent('build', null, `Installed addon “${addon.name}” v${addon.version} (${source})`)
      const withheld = addon.permissions.filter(g => !addon.granted.includes(g))
      flash(withheld.length
        ? `Installed ${addon.name} · grant ${withheld.join(', ')} in Settings → Addons to enable those features`
        : `Installed ${addon.name} v${addon.version}`)
    },
  }
}
