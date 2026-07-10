// Global (non-domain) UI lifecycle effects: surface background failures to the
// dev/webview console, and the ⌘K / Escape global keyboard shortcuts. No domain
// state of its own — drives the store only through dispatch.
import { useEffect } from 'react'
import { dispatch, useAppStore } from '../core/store'
import { setGithubTokenSource } from '../infrastructure/native/http'
import { focusSessionIn, workspaceTabOrder, activeSessionId } from '../domains/session/layout-state'
import { applyAppearance, steppedUiScale } from './appearance'

// GitHub fetchers read the PAT lazily from the live store (set once, module scope)
setGithubTokenSource(() => useAppStore.getState().settings.githubToken ?? '')

export function useGlobalEffects(): void {
  // appearance: stamp theme/density/typography onto <html> now and on every
  // settings change; re-resolve the 'system' theme when the OS scheme flips
  useEffect(() => {
    let current = useAppStore.getState().settings.appearance
    applyAppearance(current)
    const unsub = useAppStore.subscribe(s => {
      const next = s.settings.appearance
      if (next === current) return
      current = next
      applyAppearance(next)
    })
    const mq = window.matchMedia?.('(prefers-color-scheme: light)')
    const onScheme = () => applyAppearance(useAppStore.getState().settings.appearance)
    mq?.addEventListener?.('change', onScheme)
    return () => {
      unsub()
      mq?.removeEventListener?.('change', onScheme)
    }
  }, [])

  // surface background failures that would otherwise vanish (the webview console
  // reaches the dev log / devtools — the app shows no crash UI)
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => console.error('[yaam] unhandled rejection:', e.reason)
    const onError = (e: ErrorEvent) => console.error('[yaam] uncaught error:', e.message, e.error)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])

  // Global keyboard shortcuts. ⌘ on mac / Ctrl elsewhere, except inside the
  // terminal where Ctrl belongs to the CLI (Ctrl+_ etc.) — there only ⌘ works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inTerminal = !!(e.target as HTMLElement | null)?.closest?.('.xterm')
      const mod = e.metaKey || (e.ctrlKey && !inTerminal)
      const zoom = (dir: -1 | 0 | 1) => {
        e.preventDefault()
        dispatch(s => ({
          ...s,
          settings: { ...s.settings, appearance: { ...s.settings.appearance, uiScale: steppedUiScale(s.settings.appearance?.uiScale, dir) } },
        }))
      }
      // focus the workspace session at `ix` in tab order (or step by `dir`)
      const jumpTab = (ix?: number, dir?: -1 | 1) => {
        e.preventDefault()
        dispatch(s => {
          const order = workspaceTabOrder(s)
          if (!order.length) return s
          let target: string | undefined
          if (ix !== undefined) target = order[ix]
          else {
            const cur = order.indexOf(activeSessionId(s) ?? '')
            target = order[(cur + (dir ?? 1) + order.length) % order.length]
          }
          return target ? focusSessionIn(s, target) : s
        })
      }

      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        dispatch(s => ({ ...s, paletteOpen: !s.paletteOpen, paletteQuery: '' }))
      } else if (mod && !e.altKey && (e.key === '=' || e.key === '+')) {
        zoom(1) // ⌘/Ctrl + — zoom in (the '=' key without shift)
      } else if (mod && !e.altKey && (e.key === '-' || e.key === '_')) {
        zoom(-1) // ⌘/Ctrl − — zoom out
      } else if (mod && !e.altKey && e.key === '0') {
        zoom(0) // ⌘/Ctrl 0 — reset zoom
      } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault() // ⌘T — new agent session (in the Work view)
        dispatch(s => ({ ...s, view: 'workspace', newSessionOpen: true }))
      } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault() // ⌘N — new board task
        dispatch(s => ({ ...s, view: 'board', newTaskOpen: true }))
      } else if (mod && !e.altKey && e.key === ',') {
        e.preventDefault() // ⌘, — settings (macOS convention)
        dispatch(s => ({ ...s, view: 'settings' }))
      } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault() // ⌘B — toggle the Master chat panel
        dispatch(s => ({ ...s, settings: { ...s.settings, sidebarHidden: !s.settings.sidebarHidden } }))
      } else if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) && useAppStore.getState().view === 'workspace') {
        // ⌘1–9 — jump to the nth session tab (Mission Control owns these on the board)
        jumpTab(Number(e.key) - 1)
      } else if (mod && e.shiftKey && (e.key === ']' || e.key === '}')) {
        jumpTab(undefined, 1) // ⌘⇧] — next session tab
      } else if (mod && e.shiftKey && (e.key === '[' || e.key === '{')) {
        jumpTab(undefined, -1) // ⌘⇧[ — previous session tab
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        jumpTab(undefined, e.shiftKey ? -1 : 1) // Ctrl(+Shift)+Tab — cycle tabs
      } else if (e.key === 'Escape') {
        dispatch(s => ({ ...s, paletteOpen: false, notifOpen: false, drawer: null, newSessionOpen: false, newTaskOpen: false }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
