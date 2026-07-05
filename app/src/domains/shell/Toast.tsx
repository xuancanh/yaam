import { useEffect } from 'react'
import { useConductorSelector } from '../../store'
import { dispatch } from '../../core/store'

/** Display the current transient store toast when one is active. Subscribes to
 *  only `state.toast`, so it isn't re-rendered by unrelated updates (e.g. every
 *  terminal output line). Owns auto-dismissal for every toast source (flash and
 *  the system messages set directly via dispatch), so no toast can get stuck. */
export function Toast() {
  const toast = useConductorSelector(s => s.toast)
  useEffect(() => {
    if (!toast) return
    // errors linger a little longer so they can be read before clearing
    const isError = /unreadable|could not save|failed|error/i.test(toast)
    const t = window.setTimeout(() => {
      dispatch(s => (s.toast === toast ? { ...s, toast: null } : s))
    }, isError ? 6000 : 2600)
    return () => window.clearTimeout(t)
  }, [toast])
  if (!toast) return null
  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)',
      background: 'var(--panel3)', border: '1px solid var(--line2)', borderRadius: 11,
      padding: '11px 18px', display: 'flex', alignItems: 'center', gap: 10, zIndex: 50,
      boxShadow: '0 12px 40px rgba(0,0,0,.5)', animation: 'cfade .3s both',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px rgba(245,196,81,.5)' }} />
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{toast}</span>
    </div>
  )
}
