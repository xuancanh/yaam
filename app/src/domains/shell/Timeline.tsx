import { useConductorSelector, shallowEqual } from '../../store'
import { EVENT_COLORS, hexToRgba } from '../../core/data'
import { ViewHeader } from '../../components/ui'

/** Render the active workspace's reverse-chronological activity feed. */
export function Timeline() {
  const s = useConductorSelector(x => ({ agents: x.agents, events: x.events }), shallowEqual)
  const byId = new Map(s.agents.map(a => [a.id, a]))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Activity">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Every agent action and Master decision, newest first</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 26px' }}>
        <div style={{ maxWidth: 720 }}>
          {s.events.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 12.5 }}>
              No activity yet — launch a session or route a task and events will land here.
            </div>
          )}
          {s.events.map(e => {
            const color = EVENT_COLORS[e.type] || 'var(--mut)'
            const soft = hexToRgba(EVENT_COLORS[e.type] || '#8B93A1', 0.16)
            const agent = e.agentId ? byId.get(e.agentId) : null
            return (
              <div key={e.id} style={{ display: 'flex', gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 9, background: soft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: color }} />
                  </div>
                  <div style={{ flex: 1, width: 2, background: '#1a1e26', margin: '3px 0', minHeight: 14 }} />
                </div>
                <div style={{ paddingBottom: 20, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color, background: soft, borderRadius: 5, padding: '2px 7px' }}>
                      {e.type.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#C7CCD6' }}>{agent ? agent.name : 'Master'}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>{e.time}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text)', marginTop: 5, lineHeight: 1.45 }}>{e.text}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
