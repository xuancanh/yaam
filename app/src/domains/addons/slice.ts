// Addon domain AppState slice. Imports only entity types (never core/types).
import type { Addon, AddonPermission, AddonSecretDecl } from '../../core/entities'

/** A staged install awaiting the user's permission-preview confirmation. Holds
 *  the raw package JSON (committed on confirm) plus the metadata the modal
 *  renders — no view HTML / handler source, so state stays lean. */
export interface AddonInstallPreview {
  json: string
  source: Addon['source']
  name: string
  version: string
  icon: string
  desc?: string
  author?: string
  minAppVersion?: string
  permissions: AddonPermission[]
  hosts?: string[]
  secrets?: AddonSecretDecl[]
  hasView: boolean
  toolCount: number
  hookNames: string[]
  hasAgent: boolean
  /** whether this replaces an already-installed addon of the same name */
  update?: { fromVersion: string }
  /** app-version compatibility (Install is blocked when not ok) */
  compat: { ok: boolean; reason?: string }
}

/** Installed addons and their runtime chat/storage. */
export interface AddonSlice {
  addons: Addon[]
  activeAddon: string | null
  /** per-addon persistent key-value storage */
  addonStorage: Record<string, Record<string, unknown>>
  /** per-addon customization chat (in-memory) */
  addonChats: Record<string, { role: 'you' | 'master'; text: string }[]>
  addonChatBusy: string | null
  /** a staged install awaiting permission-preview confirmation (null = none) */
  addonInstall: AddonInstallPreview | null
}

/** Initial addon slice for a fresh app state. */
export function freshAddonSlice(): AddonSlice {
  return { addons: [], activeAddon: null, addonStorage: {}, addonChats: {}, addonChatBusy: null, addonInstall: null }
}
