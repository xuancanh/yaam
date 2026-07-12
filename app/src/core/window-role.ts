// Which role this webview plays. The main window owns the full app state and
// all single-instance runtimes (persistence, Master/scheduler, addon hooks,
// integrations). A `workspace` satellite is spun out of the main window to show
// one workspace in its own OS window; it renders + drives that workspace but
// does not run the single-owner runtimes — it forwards its slice to main, which
// stays the sole writer. See infrastructure/native/windows.ts for the transport.

export type WindowRole =
  | { kind: 'main' }
  | { kind: 'workspace'; workspaceId: string }

/** Read this window's role from its URL (`?win=ws&ws=<id>`). Main by default. */
export function windowRole(): WindowRole {
  if (typeof location === 'undefined') return { kind: 'main' }
  const p = new URLSearchParams(location.search)
  const ws = p.get('ws')
  return p.get('win') === 'ws' && ws ? { kind: 'workspace', workspaceId: ws } : { kind: 'main' }
}

/** True when this webview is a spun-out workspace satellite. */
export function isSatelliteWindow(): boolean {
  return windowRole().kind === 'workspace'
}

/** The workspace id a satellite is pinned to, or null in the main window. */
export function satelliteWorkspaceId(): string | null {
  const r = windowRole()
  return r.kind === 'workspace' ? r.workspaceId : null
}

/** Tauri window label for a workspace satellite (labels allow [A-Za-z0-9-/:_]). */
export function workspaceWindowLabel(workspaceId: string): string {
  return 'ws-' + workspaceId.replace(/[^A-Za-z0-9\-_]/g, '_')
}
