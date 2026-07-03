import { useActions, useConductor } from '../store'
import { AgentAvatar, EditableName, IC, Icon, StatusPill, ViewHeader } from './ui'

export function Overview() {
  const s = useConductor()
  const { focusTab, resume, openPanel, openAgent, openDiff, renameSession, archiveSession, unarchiveSession, deleteSession } = useActions()
  const inWs = (a: typeof s.agents[number]) => (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace
  const active = s.agents.filter(a => !a.archived && inWs(a))
  const archived = s.agents.filter(a => a.archived && inWs(a))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="All agents">
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 8px' }}>
          {active.length} sessions{archived.length ? ` · ${archived.length} archived` : ''}
        </span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {active.map(a => {
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
                {a.task && (
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6 }}>
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--accent)', flexShrink: 0 }}>TASK</span>
                    <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>{a.task}</span>
                  </div>
                )}
                {a.summary ? (
                  <div style={{
                    background: 'var(--bg)', border: '1px solid #1a1e26', borderRadius: 8, padding: '8px 10px',
                    fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.45,
                  }}>
                    {a.summary}
                    {a.summaryAt && <span className="mono" style={{ color: 'var(--faint)', fontSize: 10, marginLeft: 6 }}>· {a.summaryAt}</span>}
                  </div>
                ) : (
                  <div className="mono" style={{
                    background: 'var(--bg)', border: '1px solid #1a1e26', borderRadius: 8, padding: '8px 10px',
                    fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {last}
                  </div>
                )}
                {a.actionNeeded && (
                  <div style={{
                    marginTop: 8, background: 'rgba(255,176,32,.07)', border: '1px solid rgba(255,176,32,.35)',
                    borderRadius: 8, padding: '7px 10px', fontSize: 11.5, color: 'var(--amber)', lineHeight: 1.4,
                    display: 'flex', gap: 7, alignItems: 'baseline',
                  }}>
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, flexShrink: 0 }}>ACTION</span>
                    <span style={{ color: '#E8C48A' }}>{a.actionNeeded}</span>
                  </div>
                )}
                <div className="mono" style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 11, color: 'var(--dim)' }}>
                  <span>{memOn} mem</span><span>{toolOn} tools</span><span>${a.cost.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
                  <button className="open-btn" onClick={() => focusTab(a.id)}>Open</button>
                  {a.status === 'idle' && (
                    <button className="resume-btn" onClick={() => resume(a.id)}>Resume</button>
                  )}
                  <button className="review-btn" onClick={() => openDiff(a.id)}>Review</button>
                  <button className="icon-btn" title="Archive session" style={{ width: 36, padding: 7 }} onClick={() => archiveSession(a.id)}>
                    <Icon paths={['M4 7h16', 'M6 7v12h12V7', 'M10 11h4']} size={15} />
                  </button>
                  <button className="icon-btn" style={{ width: 36, padding: 7 }} onClick={() => openPanel(a.id, 'memory')}>
                    <Icon paths={['M7 7h10v10H7z', ...IC.chip]} size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {archived.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--dim)', marginBottom: 10 }}>ARCHIVED</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {archived.map(a => (
                <div key={a.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, background: 'var(--panel)',
                  border: '1px solid var(--line)', borderRadius: 10, padding: '9px 13px', opacity: 0.75,
                }}>
                  <AgentAvatar agent={a} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.name}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginLeft: 8 }}>{a.repo}{a.cliSessionId ? ` · ⧉ ${a.cliSessionId.slice(0, 8)}` : ''}</span>
                  </div>
                  <button className="open-btn" style={{ flex: 'none', padding: '5px 12px' }} onClick={() => unarchiveSession(a.id)}>Restore</button>
                  <button className="icon-btn danger" title="Delete permanently" style={{ width: 28, height: 28 }} onClick={() => deleteSession(a.id)}>
                    <Icon paths={IC.close} size={13} stroke={1.8} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
