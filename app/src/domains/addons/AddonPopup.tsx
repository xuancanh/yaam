// Modal host for an addon view opened as a popup (a contributed command or a
// terminal link handler). One at a time; Esc or the backdrop closes it.
import { useEffect, useState } from 'react'
import { useConductorSelector } from '../../store'
import { IC, Icon } from '../../components/ui'
import { AddonFrame } from './AddonFrame'
import { closeAddonPopup, onAddonPopup } from './addon-ui-bus'
import type { PopupRequest } from './addon-ui-bus'

export function AddonPopup() {
  const [req, setReq] = useState<PopupRequest | null>(null)
  useEffect(() => onAddonPopup(setReq), [])
  const addon = useConductorSelector(x => (req ? x.addons.find(a => a.id === req.addonId) : undefined))
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeAddonPopup() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [req])
  if (!req || !addon?.html || !addon.enabled) return null
  const sub = req.context.url ?? (req.context.selection ? `“${req.context.selection.slice(0, 60)}”` : '')
  return (
    <div
      onMouseDown={e => { if (e.target === e.currentTarget) closeAddonPopup() }}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
    >
      <div role="dialog" aria-label={addon.name} style={{
        width: 'min(880px, 100%)', height: 'min(640px, 100%)', display: 'flex', flexDirection: 'column',
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 24px 70px rgba(0,0,0,.6)',
      }}>
        <div style={{ height: 38, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13 }}>{addon.icon}</span>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{addon.name}</span>
          {sub && <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{sub}</span>}
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="Close (Esc)" style={{ width: 26, height: 26, borderRadius: 7 }} onClick={closeAddonPopup}>
            <Icon paths={IC.close} size={13} stroke={1.8} />
          </button>
        </div>
        <AddonFrame addon={addon} context={req.context} />
      </div>
    </div>
  )
}
