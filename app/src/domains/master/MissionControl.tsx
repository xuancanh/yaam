// Mission Control: the full-screen command deck. ONE Master chat on the right
// (the same conversation as the sidebar — MasterChat is shared), and a dynamic
// stage on the left that follows whatever matters most right now: sessions
// needing a decision outrank running ones, running outrank idle — and when
// SEVERAL need a decision at once, the stage splits into a grid (up to four
// interactive panes, one per escalated session). Staged sessions are full
// Panes (safe — the Work grid is unmounted while this view shows, and each
// session's xterm is a singleton attached in exactly one place). Clicking a
// tile pins it solo; AUTO resumes priority-following.
import { useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { brainOn } from '../../llm/client'
import { readScreen } from '../../core/terminals'
import { EVENT_COLORS } from '../../core/data'
import type { Agent } from '../../core/types'
import { Icon, MasterMark } from '../../components/ui'
import { Pane } from '../session/Pane'
import { MasterChat } from './MasterChat'

// faint blueprint grid painted under the stage and rail — reads as a deck,
// costs nothing (two repeating gradients, no elements)
const DECK_GRID = {
  backgroundImage:
    'repeating-linear-gradient(0deg, transparent 0 23px, rgba(127,140,160,.05) 23px 24px),' +
    'repeating-linear-gradient(90deg, transparent 0 23px, rgba(127,140,160,.05) 23px 24px)',
} as const

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
      className="mc-tile"
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
    events: x.events,
  }), shallowEqual)
  const on = useConductorSelector(x => brainOn(x.settings))
  const { setView, focusTab } = useActions()
  const [pinned, setPinned] = useState<string | null>(null)
  // snapshot refresh: tiles re-read their terminal buffers on a slow heartbeat
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setTick(t => t + 1), 1500)
    return () => window.clearInterval(iv)
  }, [])
  // entering the deck lands you in the command channel, ready to type
  useEffect(() => {
    document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.focus()
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

  // The stage follows priority unless the user pinned a tile (a pin on a
  // session that got archived silently falls back to auto). In auto, EVERY
  // session needing a decision takes the stage together — up to four panes.
  const needsSessions = sessions.filter(a => a.status === 'needs')
  const pinnedAgent = pinned ? sessions.find(a => a.id === pinned) : undefined
  const stagedList: Agent[] = pinnedAgent
    ? [pinnedAgent]
    : needsSessions.length > 1 ? needsSessions.slice(0, 4)
    : sessions.slice(0, 1)
  const staged = stagedList[0] ?? null
  const auto = !pinnedAgent
  const overflow = auto && needsSessions.length > 4 ? needsSessions.length - 4 : 0

  const needs = needsSessions.length
  const running = sessions.filter(a => a.status === 'running').length
  const idle = sessions.length - needs - running
  const latestEvent = s.events[0]

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* ── header strip ── */}
      <div style={{
        height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px',
        borderBottom: '1px solid var(--line)',
        background: 'linear-gradient(180deg, var(--panel), var(--bg))',
      }}>
        <span style={{ display: 'inline-flex', animation: s.masterBusy ? 'mcsweep 2.4s linear infinite' : 'none' }}>
          <Icon paths={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 8a4 4 0 100 8 4 4 0 000-8z', 'M12 12h6.5']} size={17} stroke={1.6} />
        </span>
        <span className="grotesk" style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1.2 }}>MISSION CONTROL</span>
        {latestEvent ? (
          <span className="mono" style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 9.5, color: 'var(--dim)', letterSpacing: 0.3, overflow: 'hidden' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: EVENT_COLORS[latestEvent.type] || 'var(--mut)' }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {latestEvent.time} · {latestEvent.text}
            </span>
          </span>
        ) : (
          <span className="mono" style={{ flex: 1, fontSize: 9.5, color: 'var(--faint)', letterSpacing: 0.6 }}>ALL WORKSPACES · ONE CHANNEL</span>
        )}
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
                <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.7, color: stagedList.length > 1 ? 'var(--amber)' : 'var(--dim)' }}>
                  {stagedList.length > 1 ? `⚠ ${stagedList.length} DECISIONS ON STAGE` : 'ON STAGE'}
                </span>
                {stagedList.length === 1 && (
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text2)' }}>{staged.name}</span>
                )}
                {overflow > 0 && (
                  <span className="mono" style={{ fontSize: 9, color: 'var(--amber)' }}>+{overflow} more waiting in the rail</span>
                )}
                <button
                  className="mono"
                  title={auto ? 'Auto-following priority: decisions first, then running work. Click a tile to pin one.' : 'Pinned by you — click to resume auto-following'}
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
                {stagedList.length === 1 && (
                  <button
                    className="mono"
                    title="Open this session in the Work view"
                    onClick={() => { focusTab(staged.id); setView('workspace') }}
                    style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, cursor: 'pointer', background: 'none', border: 'none', color: 'var(--dim)', padding: '2px 4px' }}
                  >
                    OPEN IN WORK ↗
                  </button>
                )}
              </div>
              {/* 1 pane fills; 2 split side-by-side; 3–4 form a 2×2 grid */}
              <div style={{
                flex: 1, minHeight: 0, display: 'grid', gap: 1, background: 'var(--line)',
                gridTemplateColumns: stagedList.length > 1 ? '1fr 1fr' : '1fr',
                gridTemplateRows: stagedList.length > 2 ? '1fr 1fr' : '1fr',
              }}>
                {stagedList.map(a => (
                  <div key={a.id} style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg2)' }}>
                    <Pane agent={a} index={0} active={stagedList.length === 1} showRing={false} maximized={false} standalone />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--dim)', ...DECK_GRID }}>
              <MasterMark size={40} glow={false} />
              <div style={{ fontSize: 13 }}>
                {on
                  ? 'No live sessions. Ask Master for something below, or launch one from the Work view.'
                  : 'No live sessions. Launch one from the Work view — the deck lights up as sessions run.'}
              </div>
            </div>
          )}

          {/* ── the rail: every session, priority first ── */}
          {sessions.length > 1 && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--line)', background: 'var(--bg2)', ...DECK_GRID }}>
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
              <div className="mono" style={{ fontSize: 9, letterSpacing: 0.6, color: s.masterBusy ? 'var(--accent)' : on ? 'var(--dim)' : 'var(--amber)' }}>
                {s.masterBusy ? 'THINKING…' : on ? 'COMMAND CHANNEL' : 'DIRECT CHANNEL · BRAIN OFF'}
              </div>
            </div>
            {!on && (
              <button
                className="mono"
                title="Escalations and direct input work without it — add a brain to route free-form orders"
                onClick={() => setView('settings')}
                style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.4, cursor: 'pointer', background: 'none', border: '1px solid var(--line2)', borderRadius: 5, color: 'var(--mut)', padding: '2px 7px' }}
              >
                ADD BRAIN
              </button>
            )}
          </div>
          <MasterChat directTarget={staged && staged.kind !== 'chat' ? { id: staged.id, name: staged.name } : null} />
        </div>
      </div>
    </div>
  )
}
