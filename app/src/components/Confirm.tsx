import { useEffect, useState } from 'react'

// Global confirmation dialog: any code calls confirmAction() and awaits the
// user's verdict; ConfirmHost (mounted once in the shell) renders the modal.
// Destructive actions across the app funnel through this so nothing is
// deleted on a single mis-click.

export interface ConfirmOptions {
  title: string
  /** what exactly is about to happen (and whether it can be undone) */
  detail?: string
  confirmLabel?: string
  /** red confirm button (default true) — set false for reversible actions like archive */
  danger?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

// The host lives on globalThis, NOT in module scope: under Vite HMR a module
// edit gives call sites and the host component different copies of this file,
// and a module-local variable would silently split them apart.
const HOST_KEY = '__yaamConfirmHost'
type HostFn = (req: ConfirmRequest) => void
const getHost = (): HostFn | null => (globalThis as Record<string, unknown>)[HOST_KEY] as HostFn | null ?? null
const setHost = (fn: HostFn | null): void => { (globalThis as Record<string, unknown>)[HOST_KEY] = fn }

/** Ask the user to confirm a destructive action. FAILS CLOSED: with a DOM but
 *  no mounted host (a bug), it resolves false and logs — deletion never
 *  proceeds without a dialog. Headless (node tests) it resolves true. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const host = getHost()
  if (!host) {
    if (typeof document === 'undefined') return Promise.resolve(true) // headless tests
    console.error('[yaam] confirmAction called with no ConfirmHost mounted — refusing:', opts.title)
    return Promise.resolve(false)
  }
  return new Promise<boolean>(resolve => host({ ...opts, resolve }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)
  useEffect(() => {
    setHost(r => setReq(prev => {
      // a second request while one is open cancels the first (never stack)
      prev?.resolve(false)
      return r
    }))
    return () => setHost(null)
  }, [])

  if (!req) return null
  const done = (ok: boolean) => {
    req.resolve(ok)
    setReq(null)
  }
  const danger = req.danger !== false
  return (
    <div
      onClick={() => done(false)}
      onKeyDown={e => { if (e.key === 'Escape') done(false) }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '90vw', background: 'var(--panel2)', border: '1px solid var(--line2)',
          borderRadius: 14, padding: 18, boxShadow: '0 26px 70px rgba(0,0,0,.6)', animation: 'cfade .14s ease-out both',
        }}
      >
        <div className="grotesk" style={{ fontSize: 14.5, fontWeight: 600 }}>{req.title}</div>
        {req.detail && (
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginTop: 6, lineHeight: 1.55 }}>{req.detail}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="deny-btn" style={{ flex: 1, padding: 9, fontSize: 12.5 }} onClick={() => done(false)} autoFocus>
            Cancel
          </button>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, fontSize: 12.5, ...(danger ? { background: 'var(--red)', color: '#fff' } : {}) }}
            onClick={() => done(true)}
          >
            {req.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
