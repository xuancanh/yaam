// Cross-component requests to show an addon's view somewhere other than its
// tab: a modal popup (mounted once at the app root) or the docked panel of a
// specific session pane. Module-level so the palette, key handler and terminal
// link router can open them without prop plumbing.
import type { AddonViewContext } from '../../core/entities'

export interface PopupRequest { addonId: string; context: AddonViewContext }
export interface PanelRequest { addonId: string; context: AddonViewContext }

const popupSubs = new Set<(r: PopupRequest | null) => void>()
const panelSubs = new Map<string, Set<(r: PanelRequest) => void>>()

export function openAddonPopup(addonId: string, context: Omit<AddonViewContext, 'placement'>): void {
  for (const cb of popupSubs) cb({ addonId, context: { ...context, placement: 'popup' } })
}
export function closeAddonPopup(): void {
  for (const cb of popupSubs) cb(null)
}
export function onAddonPopup(cb: (r: PopupRequest | null) => void): () => void {
  popupSubs.add(cb)
  return () => { popupSubs.delete(cb) }
}

/** Ask the pane hosting `sessionId` to show the addon panel. Returns false
 *  when no pane for that session is mounted (caller falls back to a popup). */
export function openAddonPanel(sessionId: string, addonId: string, context: Omit<AddonViewContext, 'placement' | 'sessionId'>): boolean {
  const subs = panelSubs.get(sessionId)
  if (!subs?.size) return false
  for (const cb of subs) cb({ addonId, context: { ...context, sessionId, placement: 'panel' } })
  return true
}
export function onAddonPanel(sessionId: string, cb: (r: PanelRequest) => void): () => void {
  const set = panelSubs.get(sessionId) ?? new Set()
  set.add(cb)
  panelSubs.set(sessionId, set)
  return () => { set.delete(cb); if (!set.size) panelSubs.delete(sessionId) }
}
