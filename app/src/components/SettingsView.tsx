import { useActions, useConductor } from '../store'
import { hexToRgba } from '../data'
import { Switch, ViewHeader } from './ui'

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--mut)', marginBottom: 11 }}>
      {children}
    </div>
  )
}

const ORCHESTRATION: Array<{ id: 'autoRoute' | 'approveDestructive' | 'followMode'; label: string; detail: string }> = [
  { id: 'autoRoute', label: 'Auto-route requests', detail: 'Master assigns tasks to the right agent without asking first.' },
  { id: 'approveDestructive', label: 'Require approval for destructive actions', detail: 'Migrations, file deletes, and deploys pause for your sign-off.' },
  { id: 'followMode', label: 'Follow mode', detail: 'Master watches every session and escalates when action is needed.' },
]

export function SettingsView() {
  const s = useConductor()
  const { toggleSetting, toggleAgentType, toggleIntegration } = useActions()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Settings">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Agent types, integrations, and orchestration policy</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 820 }}>

          <SectionLabel>ORCHESTRATION</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            {ORCHESTRATION.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{o.detail}</div>
                </div>
                <Switch on={s.settings[o.id]} onToggle={() => toggleSetting(o.id)} />
              </div>
            ))}
          </div>

          <SectionLabel>AGENT TYPES</SectionLabel>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 26 }}>
            {s.agentTypes.map(t => (
              <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', gap: 12 }}>
                <div className="mono" style={{
                  width: 38, height: 38, borderRadius: 10, background: hexToRgba(t.color, 0.14),
                  border: `1px solid ${hexToRgba(t.color, 0.4)}`, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, fontWeight: 600, color: t.color, flexShrink: 0,
                }}>
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t.name}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{t.model}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 4, lineHeight: 1.45 }}>{t.desc}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                    <span style={{ fontSize: 11, color: t.enabled ? 'var(--green)' : '#6B7280', fontWeight: 600 }}>
                      {t.enabled ? 'Enabled' : 'Disabled'} · {t.tools} tools
                    </span>
                    <Switch on={t.enabled} onToggle={() => toggleAgentType(t.id)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <SectionLabel>INTEGRATIONS</SectionLabel>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {s.integrations.map(g => (
              <div key={g.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="grotesk" style={{
                    width: 34, height: 34, borderRadius: 9, background: 'var(--panel3)', border: '1px solid var(--line2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#C7CCD6',
                  }}>
                    {g.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--dim)' }}>{g.cat}</div>
                  </div>
                  <Switch on={g.connected} onToggle={() => toggleIntegration(g.id)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.connected ? 'var(--green)' : '#3a4150' }} />
                  <span style={{ fontSize: 11.5, color: g.connected ? 'var(--green)' : 'var(--dim)' }}>{g.detail}</span>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  )
}
