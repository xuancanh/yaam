// Mission Control: the full-screen command deck. ONE Master chat on the right
// (the same conversation as the sidebar — MasterChat is shared), and a dynamic
// stage on the left that follows whichever session matters most right now:
// sessions needing a decision outrank running ones, running outrank idle. The
// staged session is a full interactive Pane (safe — the Work view's grid is
// unmounted while this view shows, and a session's xterm is a singleton).
// Clicking a tile pins it to the stage; AUTO resumes priority-following.
import { useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { readScreen } from '../../core/terminals'
import type { Agent } from '../../core/types'
import { Icon, MasterMark } from '../../components/ui'
import { Pane } from '../session/Pane'
import { MasterChat } from './MasterChat'

/** Priority for the auto-stage: decisions first, then live work, then errors. */
function priority(a: Agent): number {
  if (a.status === 'needs') return 3
  if (a.status === 'running') return 2
  if (a.status === 'error') return 1
  return 0
}

const STATUS_META: Record<Agent['status'], { color: string; label: string }> = {
  needs: { color: 'var(--amber)', label: 'NEEDS YOU' },
  running: { color: 'var(--green)', label: 'RUNNING' },
  error: { color: 'var(--red-soft)', label: 'ERROR' },
  idle: { color: 'var(--dim)', label: 'IDLE' },
}

/** One session tile in the rail: status ring, live terminal snapshot, and the
 *  needs-reason when the session is waiting on a decision. */
function SessionTile({ agent, staged, wsName, onStage }: {
  agent: Agent
  staged: boolean
  wsName?: string
  onStage: () => void
}) {
  const meta = STATUS_META[agent.status] ?? STATUS_META.idle
  const snapshot = agent.kind === 'chat' ? [] : readScreen(agent.id, 7)
  const ring = staged ? 'var(--accent)' : agent.status === 'needs' ? 'var(--amber)' : 'var(--line2)'
  return (
    <button
      onClick={onStage}
      title={staged ? `${agent.name} — on stage` : `Put ${agent.name} on stage`}
      style={{
        width: 232, flexShrink: 0, textAlign: 'left', cursor: 'pointer',
        background: staged ? 'rgba(245,196,81,.05)' : 'var(--panel)',
        border: `1px solid ${ring}`, borderRadius: 11, padding: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', color: 'var(--text)',
        animation: agent.status === 'needs' && !staged ? 'cattn 2.6s ease-in-out infinite' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: agent.color, flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agent.name}
        </span>
        <span className="mono" style={{
          flexShrink: 0, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5, color: meta.color,
          border: `1px solid ${meta.color}`, borderRadius: 4, padding: '1px 5px',
        }}>
          {meta.label}
        </span>
      </div>
      <div className="mono" style={{
        height: 88, padding: '6px 10px', fontSize: 8.5, lineHeight: 1.45, color: 'var(--mut)',
        background: 'var(--bg3)', overflow: 'hidden', whiteSpace: 'pre', position: 'relative',
      }}>
        {agent.status === 'needs' && agent.escReason ? (
          <span style={{ color: 'var(--amber)', whiteSpace: 'pre-wrap', fontSize: 10, lineHeight: 1.5 }}>⚠ {agent.escReason}</span>
        ) : agent.kind === 'chat' ? (
          <span style={{ color: 'var(--dim)' }}>chat agent</span>
        ) : snapshot.length ? snapshot.join('\n') : (
          <span style={{ color: 'var(--faint)' }}>no live output</span>
        )}
        {/* soft fade so clipped snapshots read as a viewport, not a bug */}
        <span style={{ position: 'absolute', inset: 'auto 0 0 0', height: 22, background: 'linear-gradient(transparent, var(--bg3))' }} />
      </div>
      <div className="mono" style={{ display: 'flex', gap: 6, padding: '5px 10px', fontSize: 9, color: 'var(--faint)', borderTop: '1px solid var(--line-soft)' }}>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.repo}</span>
        {wsName && <span style={{ flexShrink: 0, color: 'var(--dim)' }}>{wsName}</span>}
      </div>
    </button>
  )
}

/** Count chip for the header strip. */
function Stat({ n, label, color, pulse }: { n: number; label: string; color: string; pulse?: boolean }) {
  return (
    <span className="mono" style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
      color: n > 0 ? color : 'var(--faint)', border: `1px solid ${n > 0 ? color : 'var(--line)'}`,
      borderRadius: 6, padding: '3px 9px',
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: n > 0 ? color : 'var(--line2)',
        animation: pulse && n > 0 ? 'cpulse 1.4s ease-in-out infinite' : 'none',
      }} />
      {n} {label}
    </span>
  )
}

export function MissionControl() {
  const s = useConductorSelector(x => ({
    agents: x.agents, workspaces: x.workspaces, activeWorkspace: x.activeWorkspace, masterBusy: x.masterBusy,
  }), shallowEqual)
  const { setView, focusTab } = useActions()
  const [pinned, setPinned] = useState<string | null>(null)
  // snapshot refresh: tiles re-read their terminal buffers on a slow heartbeat
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setTick(t => t + 1), 1500)
    return () => window.clearInterval(iv)
  }, [])

  const sessions = useMemo(() => {
    const live = s.agents.filter(a => !a.archived)
    // stable sort: priority desc, ties keep store order (creation order)
    return [...live].sort((a, b) => priority(b) - priority(a))
  }, [s.agents])

  const wsName = (a: Agent) => {
    const id = a.workspaceId ?? s.activeWorkspace
    return id === s.activeWorkspace ? undefined : s.workspaces.find(w => w.id === id)?.name
  }

  // the stage follows priority unless the user pinned a tile; a pin on a
  // session that got archived silently falls back to auto
  const staged = (pinned && sessions.find(a => a.id === pinned)) || sessions[0] || null
  const auto = !pinned || staged?.id !== pinned

  const needs = sessions.filter(a => a.status === 'needs').length
  const running = sessions.filter(a => a.status === 'running').length
  const idle = sessions.length - needs - running

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* ── header strip ── */}
      <div style={{
        height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px',
        borderBottom: '1px solid var(--line)',
        background: 'linear-gradient(180deg, var(--panel), var(--bg))',
      }}>
        <Icon paths={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 8a4 4 0 100 8 4 4 0 000-8z', 'M12 12h6.5']} size={17} stroke={1.6} />
        <span className="grotesk" style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1.2 }}>MISSION CONTROL</span>
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: 0.6 }}>ALL WORKSPACES · ONE CHANNEL</span>
        <div style={{ flex: 1 }} />
        <Stat n={needs} label="NEED YOU" color="var(--amber)" pulse />
        <Stat n={running} label="RUNNING" color="var(--green)" />
        <Stat n={idle} label="IDLE" color="var(--dim)" />
        <button
          className="open-btn"
          style={{ flex: 'none', padding: '5px 12px', fontSize: 11.5, marginLeft: 6 }}
          onClick={() => setView('workspace')}
        >
          Exit to Work
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* ── stage + rail ── */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {staged ? (
            <>
              <div style={{ height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 9, padding: '0 12px', borderBottom: '1px solid var(--line)' }}>
                <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.7, color: 'var(--dim)' }}>ON STAGE</span>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text2)' }}>{staged.name}</span>
                <button
                  className="mono"
                  title={auto ? 'Auto-following priority: decisions first, then running work. Click a tile to pin.' : 'Pinned by you — click to resume auto-following'}
                  onClick={() => setPinned(null)}
                  style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.6, cursor: 'pointer', borderRadius: 5, padding: '2px 8px',
                    background: auto ? 'rgba(61,220,151,.12)' : 'transparent',
                    border: `1px solid ${auto ? 'var(--green)' : 'var(--line2)'}`,
                    color: auto ? 'var(--green)' : 'var(--mut)',
                  }}
                >
                  {auto ? '◉ AUTO' : '⊙ PINNED — resume auto'}
                </button>
                <div style={{ flex: 1 }} />
                <button
                  className="mono"
                  title="Open this session in the Work view"
                  onClick={() => { focusTab(staged.id); setView('workspace') }}
                  style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, cursor: 'pointer', background: 'none', border: 'none', color: 'var(--dim)', padding: '2px 4px' }}
                >
                  OPEN IN WORK ↗
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Pane key={staged.id} agent={staged} index={0} active showRing={false} maximized={false} standalone />
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--dim)' }}>
              <MasterMark size={40} glow={false} />
              <div style={{ fontSize: 13 }}>No live sessions. Ask Master for something below, or launch one from the Work view.</div>
            </div>
          )}

          {/* ── the rail: every session, priority first ── */}
          {sessions.length > 1 && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
              <div style={{ display: 'flex', gap: 10, padding: 10, overflowX: 'auto' }}>
                {sessions.map(a => (
                  <SessionTile
                    key={a.id}
                    agent={a}
                    staged={staged?.id === a.id}
                    wsName={wsName(a)}
                    onStage={() => setPinned(a.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── the one chat ── */}
        <div style={{
          width: 400, flexShrink: 0, borderLeft: '1px solid var(--line)', background: 'var(--panel)',
          display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: 0, width: 2,
            background: 'linear-gradient(180deg, rgba(245,196,81,.5), transparent 60%)',
          }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', borderBottom: '1px solid var(--line)' }}>
            <MasterMark size={26} />
            <div style={{ flex: 1 }}>
              <div className="grotesk" style={{ fontSize: 13.5, fontWeight: 600 }}>Master</div>
              <div className="mono" style={{ fontSize: 9, letterSpacing: 0.6, color: s.masterBusy ? 'var(--accent)' : 'var(--dim)' }}>
                {s.masterBusy ? 'THINKING…' : 'COMMAND CHANNEL'}
              </div>
            </div>
          </div>
          <MasterChat />
        </div>
      </div>
    </div>
  )
}
