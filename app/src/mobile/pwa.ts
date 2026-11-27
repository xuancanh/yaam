// Progressive web app plumbing: service worker registration (offline shell +
// push), standalone detection, and the install prompt. Android Chrome fires
// `beforeinstallprompt` and can install from a button; iOS Safari has no API,
// so it gets the Share -> Add to Home Screen instruction instead.
import { useEffect, useState } from 'react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(f => f())

export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Register the worker once at startup. Service workers need a secure context
 *  (the HTTPS tunnel link); on the plain-HTTP LAN link this is a no-op. */
export function startPwa(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault() // keep it for our own button instead of the mini-infobar
    deferred = e as InstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => { deferred = null; emit() })
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
}

const DISMISS_KEY = 'yaam-remote-install-dismissed'

export type InstallOffer = { kind: 'prompt'; install: () => void } | { kind: 'ios' } | null

/** What to offer: a one-tap install (Android/desktop Chrome), the iOS Share
 *  instruction, or nothing (already installed, dismissed, or unsupported). */
export function useInstallOffer(): { offer: InstallOffer; dismiss: () => void } {
  const [, bump] = useState(0)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    const f = () => bump(n => n + 1)
    listeners.add(f)
    return () => { listeners.delete(f) }
  }, [])
  const dismiss = () => {
    setDismissed(true)
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode */ }
  }
  if (dismissed || isStandalone()) return { offer: null, dismiss }
  if (deferred) {
    const ev = deferred
    return {
      offer: {
        kind: 'prompt',
        install: () => {
          void ev.prompt().then(() => ev.userChoice).then(r => {
            if (r.outcome === 'accepted') { deferred = null; emit() }
          }).catch(() => {})
        },
      },
      dismiss,
    }
  }
  return { offer: isIos() ? { kind: 'ios' } : null, dismiss }
}
