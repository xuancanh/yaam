import { useActions, useConductor } from '../store'
import { ACCENT, hexToRgba, indicatorColor } from '../data'
import type { Agent } from '../types'
import { IC, Icon } from './ui'
import { NewSessionDialog } from './workspace/NewSessionDialog'
import { Divider } from './workspace/Divider'
import { Pane } from './workspace/Pane'

export function Workspace() {
  const s = useConductor()
  const { focusTab, addPane, openNewSession, closeNewSession, restoreSession, setRowSplit, setColSplit } = useActions()
  const focused = s.focusedIds
  const byId = new Map(s.agents.map(a => [a.id, a]))
  const seen = new Set<string>()
  let panes = focused
    .map((id, i) => ({ agent: byId.get(id) || s.agents[0], i }))
    .filter((p): p is { agent: Agent; i: number } => {
      if (!p.agent || seen.has(p.agent.id)) return false
      seen.add(p.agent.id)
      return true
    })
  if (s.maximizedPane !== null && panes[s.maximizedPane]) panes = [panes[s.maximizedPane]]
  const rows = panes.length <= 2 ? [panes] : panes.length <= 4 ? [panes.slice(0, 2), panes.slice(2)] : [panes.slice(0, 3), panes.slice(3)]
  const minimized = s.minimizedIds.map(id => byId.get(id)).filter((a): a is Agent => !!a)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        height: 46, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', overflowX: 'auto',
      }}>
        {s.agents.filter(a => !a.archived).map(a => {
          const active = focused.includes(a.id)
          const flash = a.status === 'needs' || a.attention
          return (
            <button
              key={a.id}
              className="tab-btn"
              onClick={() => focusTab(a.id)}
              style={{
                background: active ? 'var(--panel2)' : 'transparent',
                borderTop: `2px solid ${active ? a.color : 'transparent'}`,
              }}
            >
              <span style={{
                width: flash ? 9 : 8, height: flash ? 9 : 8, borderRadius: '50%',
                background: indicatorColor(a), flexShrink: 0,
                animation: flash ? 'cpulse 1.1s ease-in-out infinite' : 'none',
                boxShadow: flash ? `0 0 7px ${indicatorColor(a)}` : 'none',
              }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: active ? 'var(--text)' : '#9AA3B2', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{a.repo}</span>
            </button>
          )
        })}
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="Add split pane"
          onClick={addPane}
          style={{
            width: 30, height: 30, flexShrink: 0,
            background: focused.length > 1 ? hexToRgba(ACCENT, 0.14) : 'transparent',
            color: focused.length > 1 ? 'var(--accent)' : '#9AA3B2',
          }}
        >
          <Icon paths={['M4 5h16v14H4z', 'M12 5v14', 'M8 12h0', 'M16 10v4', 'M14 12h4']} size={17} />
        </button>
        <button className="icon-btn" title="New agent session" onClick={openNewSession} style={{ width: 30, height: 30, flexShrink: 0, color: '#9AA3B2' }}>
          <Icon paths={IC.plus} size={17} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--line)' }}>
        {panes.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: '#0A0B0F' }}>
            <div className="grotesk" style={{ fontSize: 17, fontWeight: 600, color: 'var(--mut)' }}>
              {minimized.length ? 'All sessions minimized' : 'No sessions yet'}
            </div>
            {!minimized.length && (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--dim)', maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
                  Launch any CLI as a live session — Claude Code, Codex, Aider, a REPL, or a plain shell.
                </div>
                <button className="approve-btn" style={{ padding: '9px 22px', fontSize: 13 }} onClick={openNewSession}>
                  New agent session
                </button>
              </>
            )}
          </div>
        ) : (
          rows.map((row, ri) => (
            <div key={ri} style={{ display: 'contents' }}>
              {ri > 0 && <Divider dir="row" onRatio={setRowSplit} />}
              <div style={{
                display: 'flex', minHeight: 0,
                flexBasis: rows.length === 1 ? '100%' : `${(ri === 0 ? s.paneSplits.row : 1 - s.paneSplits.row) * 100}%`,
                flexGrow: 0, flexShrink: 1,
              }}>
                {row.map(({ agent, i }, ci) => {
                  const ratio = s.paneSplits.cols[ri] ?? 0.5
                  const width = row.length === 1 ? '100%'
                    : row.length === 2 ? `${(ci === 0 ? ratio : 1 - ratio) * 100}%`
                    : `${100 / row.length}%`
                  return (
                    <div key={`${agent.id}-${i}`} style={{ display: 'contents' }}>
                      {ci > 0 && row.length === 2 && <Divider dir="col" onRatio={r => setColSplit(ri, r)} />}
                      {ci > 0 && row.length !== 2 && <div style={{ width: 1, flexShrink: 0 }} />}
                      <div style={{ width, minWidth: 0, display: 'flex' }}>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <Pane
                            agent={agent}
                            index={i}
                            active={i === s.activePane}
                            showRing={focused.length > 1}
                            maximized={s.maximizedPane === i}
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>
      {minimized.length > 0 && (
        <div style={{
          flexShrink: 0, background: 'var(--panel)', borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', overflowX: 'auto',
        }}>
          <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', flexShrink: 0 }}>DOCK</span>
          {minimized.map(a => {
            const flash = a.status === 'needs' || a.attention
            return (
              <button
                key={a.id}
                className="dock-chip"
                title="Restore to grid"
                onClick={() => restoreSession(a.id)}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', background: indicatorColor(a), flexShrink: 0,
                  animation: flash ? 'cpulse 1.1s ease-in-out infinite' : 'none',
                }} />
                <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{a.name}</span>
              </button>
            )
          })}
        </div>
      )}
      {s.newSessionOpen && <NewSessionDialog onClose={closeNewSession} />}
    </div>
  )
}
