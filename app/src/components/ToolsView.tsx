import { useConductor } from '../store'
import { ACCENT, PERM_COLORS, hexToRgba } from '../data'
import { ViewHeader } from './ui'

export function ToolsView() {
  const s = useConductor()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Tools & permissions">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Shared capability registry across all agents</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {s.toolsCatalog.map(t => {
            const permColor = PERM_COLORS[t.perm] || 'var(--mut)'
            return (
              <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 15 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                  <span className="grotesk" style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</span>
                  {t.built && (
                    <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--accent)', background: hexToRgba(ACCENT, 0.14), borderRadius: 5, padding: '2px 6px' }}>NEW</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--mut)', lineHeight: 1.45, minHeight: 34 }}>{t.desc}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
                    color: permColor, background: hexToRgba(permColor, 0.13), borderRadius: 6, padding: '4px 9px',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: permColor }} />
                    {t.perm}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{t.agents} agents</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
