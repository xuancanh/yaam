import { useActions, useConductor } from '../../store'
import { ACCENT, PERM_COLORS, hexToRgba } from '../../core/data'
import { ViewHeader } from '../../components/ui'

/** The Master tool permission grid — embedded in Settings → Tools. */
export function ToolsSection() {
  const s = useConductor()
  const { cycleCatalogPerm } = useActions()

  return (
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
                  <button
                    onClick={() => cycleCatalogPerm(t.id)}
                    title="Click to cycle permission"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
                      color: permColor, background: hexToRgba(permColor, 0.13),
                      border: `1px solid ${hexToRgba(permColor, 0.35)}`, borderRadius: 6, padding: '4px 9px',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: permColor }} />
                    {t.perm}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
  )
}

/** Standalone view wrapper (legacy route). */
export function ToolsView() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Tools & permissions">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>What Master may do — click a permission to change it (enforced on Master's tools)</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <ToolsSection />
      </div>
    </div>
  )
}
