// Global confirmation dialog for destructive actions. confirmAction() builds
// its overlay imperatively on document.body — no host component to mount, no
// React tree or HMR state to depend on — so a delete can never bypass the
// dialog because "the host wasn't there". Styling rides the app's CSS
// variables and button classes, so it follows the active theme.

export interface ConfirmOptions {
  title: string
  /** what exactly is about to happen (and whether it can be undone) */
  detail?: string
  confirmLabel?: string
  /** red confirm button (default true) — set false for reversible actions like archive */
  danger?: boolean
}

let openOverlay: HTMLElement | null = null

/** Ask the user to confirm a destructive action. Resolves false on Cancel,
 *  backdrop click, or Escape. Headless (no DOM — node tests) resolves true. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(true)
  // a second request while one is open replaces it (never stack)
  openOverlay?.remove()

  return new Promise<boolean>(resolve => {
    const overlay = document.createElement('div')
    openOverlay = overlay
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(4,5,8,.6);z-index:9999;display:flex;align-items:center;justify-content:center;'

    const done = (ok: boolean) => {
      overlay.remove()
      if (openOverlay === overlay) openOverlay = null
      document.removeEventListener('keydown', onKey, true)
      resolve(ok)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false) }
    }
    document.addEventListener('keydown', onKey, true)
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false) })

    const box = document.createElement('div')
    box.style.cssText =
      'width:420px;max-width:90vw;background:var(--panel2);border:1px solid var(--line2);' +
      'border-radius:14px;padding:18px;box-shadow:0 26px 70px rgba(0,0,0,.6);animation:cfade .14s ease-out both;'

    const title = document.createElement('div')
    title.className = 'grotesk'
    title.style.cssText = 'font-size:14.5px;font-weight:600;color:var(--text);'
    title.textContent = opts.title
    box.appendChild(title)

    if (opts.detail) {
      const detail = document.createElement('div')
      detail.style.cssText = 'font-size:12.5px;color:var(--mut);margin-top:6px;line-height:1.55;'
      detail.textContent = opts.detail
      box.appendChild(detail)
    }

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:8px;margin-top:16px;'

    const cancel = document.createElement('button')
    cancel.className = 'deny-btn'
    cancel.style.cssText = 'flex:1;padding:9px;font-size:12.5px;'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => done(false))

    const ok = document.createElement('button')
    ok.className = 'approve-btn'
    ok.style.cssText = 'flex:1;padding:9px;font-size:12.5px;'
    if (opts.danger !== false) ok.style.cssText += 'background:var(--red);color:#fff;'
    ok.textContent = opts.confirmLabel ?? 'Delete'
    ok.addEventListener('click', () => done(true))

    row.appendChild(cancel)
    row.appendChild(ok)
    box.appendChild(row)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    cancel.focus()
  })
}
