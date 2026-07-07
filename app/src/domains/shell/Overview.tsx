import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { formatEstimatedTokens } from '../../core/usage'
import { AgentAvatar, EditableName, IC, Icon, StatusPill, ViewHeader } from '../../components/ui'
import { UsageSummary } from './UsageSummary'
import { confirmAction } from '../../components/Confirm'

/** Compact inline token/cost readout with a slim budget bar for one agent row. */
function InlineUsage({ agent }: { agent: { used: number; cost: number; budget: number; color: string } }) {
  const pct = agent.budget > 0 ? Math.min(100, Math.round((agent.cost / agent.budget) * 100)) : 0
  return (
    <span
      title={`$${agent.cost.toFixed(2)} of $${agent.budget.toFixed(2)} budget (${pct}%)`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginLeft: 'auto' }}
    >
      <span>{formatEstimatedTokens(agent.used)}</span>
      <span style={{ color: 'var(--text)' }}>${agent.cost.toFixed(2)}</span>
      <span style={{ width: 40, height: 5, background: 'var(--panel2)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: agent.color, borderRadius: 3 }} />
      </span>
    </span>
  )
}

/** One aggregate stat tile for the fleet header strip. */
function FleetStat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 110, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: '10px 13px' }}>
      <div className="grotesk" style={{ fontSize: 19, fontWeight: 600, color: tone ?? 'var(--text)' }}>{value}</div>
      <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.5, color: 'var(--dim)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

/** The fleet as an ops console: aggregate stats, Master's routing, live
 *  session/chat/watcher cards, and the archived shelf. */
export function Overview() {
  const s = useConductorSelector(x => ({ agents: x.agents, activeWorkspace: x.activeWorkspace, tasks: x.tasks }), shallowEqual)
  const { focusTab, resume, openPanel, openAgent, openDiff, renameSession, archiveSession, unarchiveSession, deleteSession, openChat, setView } = useActions()
  // Keep legacy sessions without workspaceId in the active workspace.
  const inWs = (a: typeof s.agents[number]) => (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace
  const active = s.agents.filter(a => !a.archived && a.kind !== 'chat' && inWs(a))
  const chats = s.agents.filter(a => !a.archived && a.kind === 'chat' && inWs(a))
  const archived = s.agents.filter(a => a.archived && inWs(a))
  const watched = s.tasks.filter(t => !t.archived && (t.col === 'progress' || t.col === 'review'))
  const running = active.filter(a => a.status === 'running')
  const needs = active.filter(a => a.status === 'needs' || a.attention || a.actionNeeded)
  const spend = [...active, ...chats, ...archived].reduce((n, a) => n + a.cost, 0)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Fleet">
        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 8px' }}>
          {active.length} sessions · {chats.length} chats · {watched.length} watched tasks{archived.length ? ` · ${archived.length} archived` : ''}
        </span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {/* ── ops strip: the fleet at a glance ── */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <FleetStat label="RUNNING" value={running.length} tone={running.length ? 'var(--green)' : undefined} />
          <FleetStat label="NEEDS YOU" value={needs.length} tone={needs.length ? 'var(--amber)' : undefined} />
          <FleetStat label="WATCHED TASKS" value={watched.length} />
          <FleetStat label="CHATS" value={chats.length} />
          <FleetStat label="TOTAL SPEND" value={`$${spend.toFixed(2)}`} />
        </div>

        <UsageSummary />
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
                    background: 'var(--bg)', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '8px 10px',
                    fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.45,
                  }}>
                    {a.summary}
                    {a.summaryAt && <span className="mono" style={{ color: 'var(--faint)', fontSize: 10, marginLeft: 6 }}>· {a.summaryAt}</span>}
                  </div>
                ) : (
                  <div className="mono" style={{
                    background: 'var(--bg)', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '8px 10px',
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
                <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, fontSize: 11, color: 'var(--dim)' }}>
                  <span>{memOn} mem</span><span>{toolOn} tools</span>
                  <InlineUsage agent={a} />
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
        {watched.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--dim)', marginBottom: 10 }}>WATCHED TASKS</div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
              {watched.map(tk => (
                <div key={tk.id} style={{ background: 'var(--panel)', border: `1px solid ${tk.awaitingUser ? 'rgba(255,176,32,.45)' : 'var(--line)'}`, borderRadius: 12, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.4, padding: '1px 7px', borderRadius: 5, flexShrink: 0,
                      color: tk.col === 'review' ? 'var(--amber)' : 'var(--green)',
                      border: `1px solid ${tk.col === 'review' ? 'rgba(255,176,32,.4)' : 'rgba(61,220,151,.35)'}`,
                    }}>{tk.col.toUpperCase()}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tk.title}</span>
                    {tk.awaitingUser && <span className="mono" style={{ fontSize: 9, fontWeight: 700, color: 'var(--amber)', flexShrink: 0 }}>WAITING ON YOU</span>}
                  </div>
                  {tk.watcherNote && (
                    <div className="mono" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⌁ {tk.watcherNote}</div>
                  )}
                  <button className="open-btn" style={{ marginTop: 9, padding: '5px 0', fontSize: 11.5, width: '100%' }} onClick={() => setView('board')}>
                    Open board
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {chats.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--dim)', marginBottom: 10 }}>CHATS</div>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
              {chats.map(c => {
                const lastMsg = (c.chatLog ?? []).filter(m => m.role === 'user' || m.role === 'assistant').slice(-1)[0]
                return (
                  <div key={c.id} onClick={() => openChat(c.id)} className="palette-item" style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 12, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                      {c.status === 'running'
                        ? <span className="typing-dots" style={{ flexShrink: 0 }}><span /><span /><span /></span>
                        : <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', flexShrink: 0 }}>${c.cost.toFixed(2)}</span>}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {lastMsg?.text.replace(/\s+/g, ' ').slice(0, 90) || 'empty chat'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
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
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', flexShrink: 0 }}>
                    {formatEstimatedTokens(a.used)} · ${a.cost.toFixed(2)}
                  </span>
                  <button className="open-btn" style={{ flex: 'none', padding: '5px 12px' }} onClick={() => unarchiveSession(a.id)}>Restore</button>
                  <button className="icon-btn danger" title="Delete permanently" style={{ width: 28, height: 28 }} onClick={() => { void confirmAction({ title: `Delete session “${a.name.slice(0, 40)}”?`, detail: 'Permanently removes the session, its terminal history, and resume data. This cannot be undone.' }).then(ok => { if (ok) deleteSession(a.id) }) }}>
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
