// Multi-window transport: spawn a workspace satellite as its own OS window and
// carry the small cross-window protocol between it and the main window. All
// Tauri modules are lazy-imported so the browser build stays a no-op. See
// core/window-role.ts for how a satellite reads its role on boot.
import { isTauri } from './base'
import { onCloseRequested, currentWindowLabel } from './session'
import { workspaceWindowLabel } from '../../core/window-role'
import type { Disposable } from '../../core/ports'

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

/** Ask a satellite to close GRACEFULLY via the close-request handshake: the
 *  satellite forwards its final slice over ws:reattach, then destroys itself.
 *  Use this to reclaim a workspace; destroy skips the handshake and loses the
 *  satellite's unsynced edits. Resolves without effect if the window is gone. */
export async function requestWorkspaceWindowClose(workspaceId: string): Promise<void> {
  if (!isTauri) return
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const w = await WebviewWindow.getByLabel(workspaceWindowLabel(workspaceId))
  await w?.close().catch(() => {})
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

/** Run `cb` only when THIS window is the one being asked to close (the backend
 *  broadcasts the closing window's label; we compare it to our own). The OS
 *  close is already vetoed in Rust, so `cb` should finish its teardown and then
 *  call `destroyThisWindow()`. Returns an unsubscribe fn. */
export function onThisWindowClose(cb: () => void | Promise<void>): () => void {
  if (!isTauri) return () => {}
  return onCloseRequested(label => { if (label === currentWindowLabel()) void cb() })
}

/** Destroy every workspace-satellite window (main quitting closes the app). */
export async function closeAllSatellites(): Promise<void> {
  if (!isTauri) return
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  for (const w of await WebviewWindow.getAll()) {
    if (w.label !== MAIN_WINDOW_LABEL) await w.destroy().catch(() => {})
  }
}

/** Ask every satellite window to close GRACEFULLY (close(), NOT destroy) so
 *  each runs its close-request handshake and hands its final slice back over
 *  ws:reattach. Returns the labels of the satellites asked to close, so the
 *  caller can wait for their reattach payloads before flushing. */
export async function requestAllSatellitesClose(): Promise<string[]> {
  if (!isTauri) return []
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const closing: string[] = []
  for (const w of await WebviewWindow.getAll()) {
    if (w.label === MAIN_WINDOW_LABEL) continue
    closing.push(w.label)
    await w.close().catch(() => {})
  }
  return closing
}

// ---- main-window close sequence ----
export interface MainWindowCloseDeps {
  /** ask satellites to close gracefully; resolves to the labels asked */
  requestSatelliteClose: () => Promise<string[]>
  /** register a cb fired (with the satellite's label) when a ws:reattach
   *  handoff payload arrives; the caller merges the payload BEFORE calling cb */
  onReattach: (cb: (label: string) => void) => void
  /** persistence flush (the caller's sole-writer save) */
  flush: () => Promise<void>
  /** destroy any satellites still alive after the grace window */
  destroySatellites: () => Promise<void>
  destroyMain: () => Promise<void>
  setTimeout: (fn: () => void, ms: number) => Disposable
  /** how long to wait for reattach handoffs before flushing anyway */
  graceMs?: number
  /** cap on the flush wait */
  flushMs?: number
}

/** Main-window quit, ordered so no satellite edits are lost: (1) ask satellites
 *  to close gracefully so each fires ws:reattach with its final slice, (2) wait
 *  — bounded by graceMs — until every closing satellite's handoff has arrived
 *  (the caller merges each before notifying), (3) flush persistence, (4) destroy
 *  stragglers + main. Bounded overall (graceMs + flushMs) so quit can't hang. */
export async function runMainWindowClose(d: MainWindowCloseDeps): Promise<void> {
  const graceMs = d.graceMs ?? 2000
  const flushMs = d.flushMs ?? 3000
  const arrived = new Set<string>()
  let notify: (() => void) | undefined
  d.onReattach(label => { arrived.add(label); notify?.() })
  const closing = await d.requestSatelliteClose()
  const pending = () => closing.some(l => !arrived.has(l))
  if (pending()) {
    await new Promise<void>(resolve => {
      const timer = d.setTimeout(() => { notify = undefined; resolve() }, graceMs)
      notify = () => {
        if (!pending()) { notify = undefined; timer.dispose(); resolve() }
      }
    })
  }
  await Promise.race([d.flush(), new Promise<void>(r => { d.setTimeout(() => r(), flushMs) })])
  await d.destroySatellites()
  await d.destroyMain()
}

/** Destroy this window (bypasses the close-request veto after a flush). */
export async function destroyThisWindow(): Promise<void> {
  if (!isTauri) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().destroy().catch(() => {})
}

/** Zoom this webview like a browser's ⌘+/⌘− (WebKit setPageZoom / WebView2
 *  ZoomFactor / WebKitGTK zoom-level). Unlike CSS `zoom` on the root, native
 *  zoom recomputes viewport units, so the 100vh/100vw layout keeps fitting on
 *  every engine — spec-compliant CSS `zoom` (Safari 18+, Chromium, WebKitGTK)
 *  overflows it. Returns false in a plain browser so the caller can fall back
 *  to CSS `zoom`. */
export async function setWebviewZoom(factor: number): Promise<boolean> {
  if (!isTauri) return false
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  await getCurrentWebview().setZoom(factor).catch(() => {})
  return true
}
