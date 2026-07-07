// Addon domain AppState slice. Imports only entity types (never core/types).
import type { Addon } from '../../core/entities'

/** Installed addons and their runtime chat/storage. */
export interface AddonSlice {
  addons: Addon[]
  activeAddon: string | null
  /** per-addon persistent key-value storage */
  addonStorage: Record<string, Record<string, unknown>>
  /** per-addon customization chat (in-memory) */
  addonChats: Record<string, { role: 'you' | 'master'; text: string }[]>
  addonChatBusy: string | null
}

/** Initial addon slice for a fresh app state. */
export function freshAddonSlice(): AddonSlice {
  return { addons: [], activeAddon: null, addonStorage: {}, addonChats: {}, addonChatBusy: null }
}
