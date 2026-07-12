// Multi-window transport: spawn a workspace satellite as its own OS window and
// carry the small cross-window protocol between it and the main window. All
// Tauri modules are lazy-imported so the browser build stays a no-op. See
// core/window-role.ts for how a satellite reads its role on boot.
import { isTauri } from './base'
import { workspaceWindowLabel } from '../../core/window-role'

export const MAIN_WINDOW_LABEL = 'main'

/** Open (or focus, if already open) a satellite window pinned to a workspace. */
export async function openWorkspaceWindow(workspaceId: string, title: string): Promise<void> {
  const url = `index.html?win=ws&ws=${encodeURIComponent(workspaceId)}`
  if (!isTauri) { try { window.open(url, '_blank', 'width=1200,height=800') } catch { /* jsdom/no-op */ } return }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const label = workspaceWindowLabel(workspaceId)
  const existing = await WebviewWindow.getByLabel(label)
  if (existing) { await existing.setFocus().catch(() => {}); return }
  new WebviewWindow(label, {
    url, title: title || 'Workspace',
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#08090C', titleBarStyle: 'overlay', hiddenTitle: true,
  })
}

/** Ask a workspace satellite window to close (e.g. its workspace was deleted). */
export async function closeWorkspaceWindow(workspaceId: string): Promise<void> {
  if (!isTauri) return
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const w = await WebviewWindow.getByLabel(workspaceWindowLabel(workspaceId))
  await w?.destroy().catch(() => {})
}

// ---- cross-window event protocol ----
export interface WsSyncPayload {
  workspaceId: string
  /** the satellite's authoritative WorkspaceData slice for this workspace */
  data: unknown
  /** the session records owned by this workspace (workspaceId === id) */
  agents: unknown[]
}

/** Satellite → main: forward the workspace slice so main (sole writer) persists it. */
export async function emitWsSync(payload: WsSyncPayload): Promise<void> {
  if (!isTauri) return
  const { emitTo } = await import('@tauri-apps/api/event')
  await emitTo(MAIN_WINDOW_LABEL, 'ws:sync', payload).catch(() => {})
}

/** Satellite → main: the satellite is closing; hand its workspace back. */
export async function emitWsReattach(payload: WsSyncPayload): Promise<void> {
  if (!isTauri) return
  const { emitTo } = await import('@tauri-apps/api/event')
  await emitTo(MAIN_WINDOW_LABEL, 'ws:reattach', payload).catch(() => {})
}

/** Main: subscribe to a satellite protocol event. Returns an unsubscribe fn. */
export function onWsEvent<T>(event: 'ws:sync' | 'ws:reattach', cb: (payload: T) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  void import('@tauri-apps/api/event').then(({ listen }) =>
    listen<T>(event, e => cb(e.payload)).then(fn => { if (alive) unlisten = fn; else fn() }))
  return () => { alive = false; unlisten() }
}

/** Subscribe to this window's own close-request (satellite flushes then closes). */
export function onWindowClose(cb: () => void | Promise<void>): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(async e => { e.preventDefault(); await cb() }).then(fn => { if (alive) unlisten = fn; else fn() }))
  return () => { alive = false; unlisten() }
}

/** Destroy this window (bypasses the close-request veto after a flush). */
export async function destroyThisWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().destroy().catch(() => {})
}
