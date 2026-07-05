import { useActions, useConductor } from '../../store'
import { ACCENT, PERM_COLORS, hexToRgba, memTokens } from '../../data'
import { AgentAvatar, IC, Icon, Switch } from '../../components/ui'

/** Route the active slide-over panel to its specialized content component. */
export function SlideOver() {
  const s = useConductor()
  const { closePanel, setPanelTab, toggleMem, toggleTool, cyclePerm } = useActions()

  if (!s.panel) return null
  const agent = s.agents.find(a => a.id === s.panel!.agentId)
  if (!agent) return null
  const tab = s.panel.tab

  const memOn = agent.memory.filter(m => m.on)
  const memTotal = memOn.reduce((n, m) => n + memTokens(agent, m.id), 0)

  return (
    <>
      <div onClick={closePanel} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.5)', zIndex: 40 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 392, background: 'var(--panel)',
        borderLeft: '1px solid var(--line2)', zIndex: 41, display: 'flex', flexDirection: 'column',
        boxShadow: '-24px 0 60px rgba(0,0,0,.45)', animation: 'cslide .22s ease-out both',
      }}>
        <div style={{ padding: '15px 17px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 11 }}>
          <AgentAvatar agent={agent} size={30} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{agent.name}</div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{agent.repo} · {agent.branch}</div>
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28, borderRadius: 7 }} onClick={closePanel}>
            <Icon paths={IC.close} size={15} stroke={1.8} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '10px 15px 0', borderBottom: '1px solid var(--line)' }}>
          {(['memory', 'tools'] as const).map(t => (
            <button
              key={t}
              onClick={() => setPanelTab(t)}
              style={{
                padding: '8px 14px', background: 'transparent', border: 'none',
                borderBottom: `2px solid ${tab === t ? ACCENT : 'transparent'}`,
                color: tab === t ? 'var(--text)' : 'var(--mut)', fontSize: 13, fontWeight: 600,
              }}
            >
              {t === 'memory' ? 'Memory' : 'Tools'}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 15px' }}>
          {tab === 'memory' ? (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--mut)', marginBottom: 14 }}>
                What this session contributes to Master's context ·{' '}
                <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{memTotal.toFixed(2)}k</span>
                {' '}tokens
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {agent.memory.map(m => (
                  <div key={m.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12, background: 'var(--panel2)',
                    border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: m.on ? 'var(--text)' : '#6B7280' }}>{m.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{m.detail} · {memTokens(agent, m.id).toFixed(2)}k</div>
                    </div>
                    <Switch on={m.on} onToggle={() => toggleMem(agent.id, m.id)} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--mut)', marginBottom: 14 }}>
                What Master may do to this session. Auto acts freely, Ask first makes Master confirm in chat, Approval/Off blocks it.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {agent.tools.map(t => {
                  const permColor = PERM_COLORS[t.perm] || 'var(--mut)'
                  return (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12, background: 'var(--panel2)',
                      border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px',
                    }}>
                      <Switch on={t.on} onToggle={() => toggleTool(agent.id, t.id)} />
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: t.on ? 'var(--text)' : '#6B7280' }}>{t.name}</span>
                      <button
                        onClick={() => cyclePerm(agent.id, t.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
                          color: permColor, background: hexToRgba(permColor, 0.13),
                          border: `1px solid ${hexToRgba(permColor, 0.35)}`, borderRadius: 7, padding: '5px 10px',
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: permColor }} />
                        {t.perm}
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
