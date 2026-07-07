// Shell domain AppState slice. Imports only entity types (never core/types).
import type { View, Panel, Drawer } from '../../core/entities'

/** Global shell UI: current view, composer, palette, drawer, toast, remote server. */
export interface ShellUiSlice {
  view: View
  composer: string
  panel: Panel | null
  toast: string | null
  drawer: Drawer | null
  paletteOpen: boolean
  paletteQuery: string
  notifOpen: boolean
  /** phone remote companion server, when running (transient — not persisted) */
  remoteInfo?: { url: string; token: string; urls: { label: string; url: string }[] } | null
}

/** Initial shell UI slice for a fresh app state. */
export function freshShellUiSlice(): ShellUiSlice {
  return {
    view: 'workspace',
    composer: '',
    panel: null,
    toast: null,
    drawer: null,
    paletteOpen: false,
    paletteQuery: '',
    notifOpen: false,
  }
}
