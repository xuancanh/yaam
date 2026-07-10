import type { ReactNode } from 'react'
import { IC, Icon } from './ui'

// Shared spacious modal for viewing & editing one configured entity —
// templates, terminal/chat agent types, machines, MCP servers. The list views
// stay compact summaries; clicking a card opens one of these with room for
// every field. Fields save as the caller wires them (usually draft-on-blur).

/** Fixed overlay + wide panel. Overlay click closes; panel clicks don't. */
export function EntityDialog({ onClose, width = 760, children }: {
  onClose: () => void
  width?: number
  children: ReactNode
}) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '7vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto', background: 'var(--panel2)',
          border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 26,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** Dialog title row: leading badge/avatar, title (often an EditableName),
 *  caller-supplied actions, and the standard close button. */
export function DialogHeader({ lead, title, sub, actions, onClose }: {
  lead?: ReactNode
  title: ReactNode
  /** one-line summary under the title (view-at-a-glance) */
  sub?: ReactNode
  actions?: ReactNode
  onClose: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
      {lead}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{title}</div>
        {sub && <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {actions}
      <button className="icon-btn" title="Close" style={{ width: 28, height: 28, borderRadius: 7, flexShrink: 0 }} onClick={onClose}>
        <Icon paths={IC.close} size={13} stroke={1.8} />
      </button>
    </div>
  )
}

/** Labeled form group with an optional inline hint. */
export function DialogField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.3 }}>{label}</span>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** Two-column grid for short paired fields inside a dialog. */
export function DialogGrid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>{children}</div>
}

/** Standard bottom row: caller extras on the left, Done on the right. */
export function DialogFooter({ onClose, children }: { onClose: () => void; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
      {children}
      <div style={{ flex: 1 }} />
      <button className="approve-btn" style={{ flex: 'none', padding: '9px 26px' }} onClick={onClose}>Done</button>
    </div>
  )
}
