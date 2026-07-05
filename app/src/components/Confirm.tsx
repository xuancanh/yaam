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
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

let host: ((req: ConfirmRequest) => void) | null = null

/** Ask the user to confirm a destructive action. Resolves false when the
 *  dialog is dismissed (backdrop, Escape via Cancel) or no host is mounted
 *  headlessly (tests) — deletion never proceeds silently. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (!host) return Promise.resolve(true) // headless (tests, addon iframes)
  return new Promise<boolean>(resolve => host!({ ...opts, resolve }))
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)
  useEffect(() => {
    host = r => setReq(prev => {
      // a second request while one is open cancels the first (never stack)
      prev?.resolve(false)
      return r
    })
    return () => { host = null }
  }, [])

  if (!req) return null
  const done = (ok: boolean) => {
    req.resolve(ok)
    setReq(null)
  }
  return (
    <div
      onClick={() => done(false)}
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
            style={{ flex: 1, padding: 9, fontSize: 12.5, background: 'var(--red)', color: '#fff' }}
            onClick={() => done(true)}
          >
            {req.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
