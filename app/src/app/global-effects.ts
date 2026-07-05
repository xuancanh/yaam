// Global (non-domain) UI lifecycle effects: surface background failures to the
// dev/webview console, and the ⌘K / Escape global keyboard shortcuts. No domain
// state of its own — drives the store only through dispatch.
import { useEffect } from 'react'
import { dispatch, useAppStore } from '../core/store'
import { applyAppearance } from './appearance'

export function useGlobalEffects(): void {
  // appearance: stamp theme/density/typography onto <html> now and on every
  // settings change; re-resolve the 'system' theme when the OS scheme flips
  useEffect(() => {
    applyAppearance(useAppStore.getState().settings.appearance)
    const unsub = useAppStore.subscribe(s => applyAppearance(s.settings.appearance))
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

  // ⌘K / Ctrl+K toggles the command palette; Escape closes overlays — unless an
  // editable control owns the keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        dispatch(s => ({ ...s, paletteOpen: !s.paletteOpen, paletteQuery: '' }))
      } else if (e.key === 'Escape') {
        dispatch(s => ({ ...s, paletteOpen: false, notifOpen: false, drawer: null, newSessionOpen: false }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
