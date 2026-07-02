import { useActions, useConductor } from '../store'
import { ACCENT, STATUS_META, hexToRgba } from '../data'
import { AgentAvatar, EditableName, IC, Icon, StatusPill, ViewHeader } from './ui'

const GRAPH_POS = [
  { x: 150, y: 62 },
  { x: 570, y: 62 },
  { x: 150, y: 178 },
  { x: 570, y: 178 },
]

function SessionFlow() {
  const s = useConductor()
  const core = s.agents.slice(0, 4)
  const nodes = core.map((a, i) => ({ agent: a, ...GRAPH_POS[i] }))
  const dep = nodes.length >= 2
    ? `M ${nodes[0].x} ${nodes[0].y} C ${nodes[0].x} 16 ${nodes[1].x} 16 ${nodes[1].x} ${nodes[1].y}`
    : null

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, padding: '15px 18px', marginBottom: 16 }}>
      <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--mut)', marginBottom: 4 }}>SESSION FLOW</div>
      <svg viewBox="0 0 720 240" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 206, display: 'block' }}>
        <defs>
          <marker id="cflow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#FFB020" />
          </marker>
        </defs>
        {nodes.map(n => (
          <line key={n.agent.id} x1={360} y1={120} x2={n.x} y2={n.y} stroke={hexToRgba(n.agent.color, 0.45)} strokeWidth={1.5} />
        ))}
        {dep && (
          <>
            <path d={dep} fill="none" stroke="#FFB020" strokeWidth={1.5} strokeDasharray="4 4" markerEnd="url(#cflow)" />
            <text x={360} y={26} textAnchor="middle" fill="#8B93A1" fontSize={11} fontFamily="JetBrains Mono, monospace">waits for rate-limiter</text>
          </>
        )}
        <circle cx={360} cy={120} r={30} fill={hexToRgba(ACCENT, 0.14)} stroke={ACCENT} strokeWidth={1.5} />
        <text x={360} y={117} textAnchor="middle" fill={ACCENT} fontWeight={600} fontSize={13} fontFamily="Space Grotesk, sans-serif">Master</text>
        <text x={360} y={132} textAnchor="middle" fill="#8B93A1" fontSize={9} fontFamily="JetBrains Mono, monospace">orchestrator</text>
        {nodes.map(n => {
          const sm = STATUS_META[n.agent.status] || STATUS_META.idle
          return (
            <g key={n.agent.id}>
              <circle cx={n.x} cy={n.y} r={24} fill={hexToRgba(n.agent.color, 0.14)} stroke={n.agent.color} strokeWidth={1.5} />
              <text x={n.x} y={n.y} dy={4} textAnchor="middle" fill={n.agent.color} fontWeight={600} fontSize={11} fontFamily="JetBrains Mono, monospace">{n.agent.short}</text>
              <text x={n.x} y={n.y + 44} textAnchor="middle" fill="#C7CCD6" fontSize={11} fontFamily="IBM Plex Sans, sans-serif">{n.agent.name}</text>
              <circle cx={n.x + 18} cy={n.y - 18} r={4} fill={sm.color} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Overview() {
  const s = useConductor()
  const { focusTab, resume, openPanel, openAgent, openDiff, renameSession } = useActions()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="All agents">
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 8px' }}>
          {s.agents.length} sessions
        </span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <SessionFlow />
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {s.agents.map(a => {
            const memOn = a.memory.filter(m => m.on).length
            const toolOn = a.tools.filter(t => t.on).length
            const last = a.log.length ? a.log[a.log.length - 1].x : ''
            return (
              <div key={a.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 14, padding: 15 }}>
                <div onClick={() => openAgent(a.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, cursor: 'pointer' }}>
                  <AgentAvatar agent={a} size={34} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <EditableName name={a.name} onRename={name => renameSession(a.id, name)} />
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 1 }}>{a.repo} · {a.branch}</div>
                  </div>
                  <StatusPill agent={a} small />
                </div>
                <div className="mono" style={{
                  background: 'var(--bg)', border: '1px solid #1a1e26', borderRadius: 8, padding: '8px 10px',
                  fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {last}
                </div>
                <div className="mono" style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: 'var(--dim)' }}>
                  <span>{memOn} mem</span><span>{toolOn} tools</span><span>${a.cost.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
                  <button className="open-btn" onClick={() => focusTab(a.id)}>Open</button>
                  {a.status === 'idle' && (
                    <button className="resume-btn" onClick={() => resume(a.id)}>Resume</button>
                  )}
                  <button className="review-btn" onClick={() => openDiff(a.id)}>Review</button>
                  <button className="icon-btn" style={{ width: 36, padding: 7 }} onClick={() => openPanel(a.id, 'memory')}>
                    <Icon paths={['M7 7h10v10H7z', ...IC.chip]} size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
