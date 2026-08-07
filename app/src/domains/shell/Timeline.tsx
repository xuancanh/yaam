import { useState } from 'react'
import { useConductorSelector, shallowEqual } from '../../store'
import { EVENT_COLORS, hexToRgba, uiTint } from '../../core/data'
import { ViewHeader } from '../../components/ui'

/** Text above this length is clamped to two lines until clicked open. */
const CLAMP_AT = 140

/** One event's body: long text collapses to a two-line clamp by default and
 *  toggles open on click, so a wall of routed-task descriptions stays scannable. */
function EventText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > CLAMP_AT || text.includes('\n')
  return (
    <div
      onClick={long ? () => setOpen(o => !o) : undefined}
      title={long && !open ? 'Click to expand' : undefined}
      style={{
        fontSize: 12.5, color: 'var(--text2)', marginTop: 4, lineHeight: 1.45, whiteSpace: 'pre-wrap',
        cursor: long ? 'pointer' : undefined,
        ...(long && !open
          ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }
          : {}),
      }}
    >
      {text}
      {long && open && <span style={{ color: 'var(--dim)', fontSize: 11 }}>  · collapse</span>}
    </div>
  )
}

/** Render the active workspace's reverse-chronological activity feed. */
export function Timeline() {
  const s = useConductorSelector(x => ({ agents: x.agents, events: x.events }), shallowEqual)
  const byId = new Map(s.agents.map(a => [a.id, a]))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Activity">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Every agent action and Master decision, newest first · click an entry to expand it</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 26px' }}>
        <div style={{ maxWidth: 720 }}>
          {s.events.length === 0 && (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 12.5 }}>
              No activity yet — launch a session or route a task and events will land here.
            </div>
          )}
          {s.events.map(e => {
            const color = EVENT_COLORS[e.type] ? uiTint(EVENT_COLORS[e.type]) : 'var(--mut)'
            const soft = hexToRgba(uiTint(EVENT_COLORS[e.type] || '#8B93A1'), 0.16)
            const agent = e.agentId ? byId.get(e.agentId) : null
            return (
              <div key={e.id} style={{ display: 'flex', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 8, background: soft, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                  </div>
                  <div style={{ flex: 1, width: 2, background: 'var(--line-soft)', margin: '3px 0', minHeight: 8 }} />
                </div>
                <div style={{ paddingBottom: 12, flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color, background: soft, borderRadius: 5, padding: '2px 7px' }}>
                      {e.type.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>{agent ? agent.name : 'Master'}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>{e.time}</span>
                  </div>
                  <EventText text={e.text} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
