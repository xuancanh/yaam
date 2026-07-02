import { useActions, useConductor } from '../store'
import { ACCENT, hexToRgba } from '../data'
import { IC, Icon, Switch, ViewHeader } from './ui'

export function Schedules() {
  const s = useConductor()
  const { toggleCron } = useActions()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Schedules">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Recurring agent runs — some built by Master</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {s.crons.map(c => (
          <div key={c.id} style={{
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12,
            padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <Switch on={c.on} onToggle={() => toggleCron(c.id)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                {c.built && (
                  <span style={{
                    display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
                    color: 'var(--accent)', background: hexToRgba(ACCENT, 0.14), borderRadius: 5, padding: '2px 7px',
                  }}>
                    <Icon paths={IC.bolt} size={10} stroke={2} />built by Master
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 11.5, color: 'var(--mut)' }}>
                <span className="mono" style={{ color: 'var(--dim)' }}>{c.schedule}</span>
                <span>{c.human}</span>
                <span style={{ color: 'var(--faint)' }}>·</span>
                <span>{c.target}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color }} />
              <span style={{ fontSize: 12, color: '#C7CCD6' }}>{c.agent}</span>
            </div>
            <div className="mono" style={{ width: 150, textAlign: 'right', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{c.last}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
