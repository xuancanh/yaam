// Mission Control: the full-screen command deck. A dynamic stage plus a
// priority rail that follow whatever matters most right now: sessions
// needing a decision outrank running ones, running outrank idle — and when
// SEVERAL need a decision at once, the stage splits into a grid (up to four
// interactive panes, one per escalated session). Staged sessions are full
// Panes (safe — the Work grid is unmounted while this view shows, and each
// session's xterm is a singleton attached in exactly one place). Clicking a
// tile pins it solo; AUTO resumes priority-following.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { brainOn } from '../../llm/client'
import { readScreen } from '../../core/terminals'
import { EVENT_COLORS } from '../../core/data'
import type { Agent } from '../../core/types'
import { Icon, MasterMark } from '../../components/ui'
import { Pane } from '../session/Pane'
import { requestQuickShellToggle } from '../session/QuickShell'
import { onMissionStage } from './mission-bus'

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

/** An unresolved escalation's answerable surface, mined from the chat stream. */
interface TileEsc {
  options?: { num: number; label: string }[]
}

/** One session tile in the rail: status ring, live terminal snapshot with an
 *  activity glow when output just moved, the needs-reason when waiting — and
 *  the decision's OWN controls (approve/deny or the numbered options), so
 *  routine calls are answered from the rail without staging anything. */
function SessionTile({ agent, staged, ix, esc, onStage }: {
  agent: Agent
  staged: boolean
  /** rail position — first nine entries stage with ⌘1–9 */
  ix: number
  /** the session's unresolved escalation (options included), if any */
  esc?: TileEsc | null
  onStage: () => void
}) {
  const { approve, deny, answerPrompt } = useActions()
  const meta = STATUS_META[agent.status] ?? STATUS_META.idle
  const snapshot = agent.kind === 'chat' ? [] : readScreen(agent.id, 7)

  // activity glow: when the snapshot text changes between heartbeats, the
  // tile's LED brightens briefly — a wall of monitors you can read at a glance
  const snapText = snapshot.join('\n')
  const prevSnap = useRef(snapText)
  const [glow, setGlow] = useState(false)
  useEffect(() => {
    if (prevSnap.current === snapText) return
    prevSnap.current = snapText
    setGlow(true)
    const t = window.setTimeout(() => setGlow(false), 1300)
    return () => window.clearTimeout(t)
  }, [snapText])

  const ring = staged ? 'var(--accent)' : agent.status === 'needs' ? 'var(--amber)' : glow ? 'var(--green)' : 'var(--line2)'
  const needsHere = agent.status === 'needs'
  const opts = esc?.options?.slice(0, 4)
  return (
    <div
      role="button"
      tabIndex={0}
      className="mc-tile"
      onClick={onStage}
      onKeyDown={e => { if (e.key === 'Enter') onStage() }}
      title={staged ? `${agent.name} — on stage` : `Put ${agent.name} on stage`}
      style={{
        width: 232, flexShrink: 0, textAlign: 'left', cursor: 'pointer',
        background: staged ? 'rgba(245,196,81,.05)' : 'var(--panel)',
        border: `1px solid ${ring}`, borderRadius: 11, padding: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', color: 'var(--text)',
        animation: needsHere && !staged ? 'cattn 2.6s ease-in-out infinite' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderBottom: '1px solid var(--line-soft)' }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: agent.color, flexShrink: 0,
          boxShadow: glow ? `0 0 6px 1px ${agent.color}` : 'none', transition: 'box-shadow .3s',
        }} />
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
        height: needsHere ? 62 : 88, padding: '6px 10px', fontSize: 8.5, lineHeight: 1.45, color: 'var(--mut)',
        background: 'var(--bg3)', overflow: 'hidden', whiteSpace: 'pre', position: 'relative',
      }}>
        {needsHere && agent.escReason ? (
          <span style={{ color: 'var(--amber)', whiteSpace: 'pre-wrap', fontSize: 10, lineHeight: 1.5 }}>⚠ {agent.escReason}</span>
        ) : agent.kind === 'chat' ? (
          <span style={{ color: 'var(--dim)' }}>chat agent</span>
        ) : snapshot.length ? snapshot.join('\n') : (
          <span style={{ color: 'var(--faint)' }}>no live output</span>
        )}
        {/* soft fade so clipped snapshots read as a viewport, not a bug */}
        <span style={{ position: 'absolute', inset: 'auto 0 0 0', height: 22, background: 'linear-gradient(transparent, var(--bg3))' }} />
      </div>
      {/* answer the decision right here — no staging required for routine calls */}
      {needsHere && (
        opts?.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 8px', borderTop: '1px solid var(--line-soft)' }}>
            {opts.map(o => (
              <button
                key={o.num}
                className="mono"
                title={o.label}
                onClick={e => { e.stopPropagation(); answerPrompt(agent.id, o.num) }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', maxWidth: '100%',
                  fontSize: 9.5, borderRadius: 6, padding: '3px 8px', background: 'var(--bg2)',
                  border: '1px solid var(--line2)', color: 'var(--text2)',
                }}
              >
                <span style={{ color: 'var(--accent)', fontWeight: 700, flexShrink: 0 }}>{o.num}</span>
                <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderTop: '1px solid var(--line-soft)' }}>
            <button
              className="approve-btn"
              onClick={e => { e.stopPropagation(); approve(agent.id) }}
              style={{ flex: 1, padding: '4px 0', fontSize: 10.5 }}
            >
              ✓ Approve
            </button>
            <button
              className="deny-btn"
              onClick={e => { e.stopPropagation(); deny(agent.id) }}
              style={{ flex: 1, padding: '4px 0', fontSize: 10.5 }}
            >
              ✕ Deny
            </button>
          </div>
        )
      )}
      <div className="mono" style={{ display: 'flex', gap: 6, padding: '5px 10px', fontSize: 9, color: 'var(--faint)', borderTop: '1px solid var(--line-soft)' }}>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.repo}</span>
        {ix < 9 && <span style={{ flexShrink: 0, color: staged ? 'var(--accent)' : 'var(--faint)' }}>⌘{ix + 1}</span>}
      </div>
    </div>
  )
}

/** Idle sessions collapse to compact pills — present, stageable, but quiet, so
 *  the rail's real estate belongs to sessions that are doing something. */
function QuietChip({ agent, ix, staged, onStage }: { agent: Agent; ix: number; staged: boolean; onStage: () => void }) {
  return (
    <button
      className="mono"
      onClick={onStage}
      title={`${agent.name} — idle · click to stage`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', maxWidth: 190,
        fontSize: 10, borderRadius: 999, padding: '4px 11px',
        background: staged ? 'rgba(245,196,81,.08)' : 'var(--panel)',
        border: `1px solid ${staged ? 'var(--accent)' : 'var(--line2)'}`,
        color: staged ? 'var(--text)' : 'var(--mut)',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: agent.color, opacity: 0.6, flexShrink: 0 }} />
      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</span>
      {ix < 9 && <span style={{ flexShrink: 0, fontSize: 8.5, color: 'var(--faint)' }}>⌘{ix + 1}</span>}
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
    events: x.events, messages: x.messages,
  }), shallowEqual)
  const on = useConductorSelector(x => brainOn(x.settings))
  const { setView, focusTab, switchWorkspace } = useActions()
  const [pinned, setPinned] = useState<string | null>(null)
  // the deck follows the workspace model: switching workspaces re-scopes the
  // whole view, and a pin never carries across
  useEffect(() => setPinned(null), [s.activeWorkspace])
  // sidebar escalation cards stage their session here while the deck is up
  useEffect(() => onMissionStage(id => setPinned(id)), [])

  // each session's newest unresolved escalation (for the tiles' inline
  // answers) — messages are already scoped to the active workspace
  const escByAgent = useMemo(() => {
    const m = new Map<string, TileEsc>()
    for (const msg of s.messages) {
      if (msg.kind === 'escalate' && msg.escFor && msg.esc && !msg.esc.resolved) {
        m.set(msg.escFor, { options: msg.esc.options })
      }
    }
    return m
  }, [s.messages])
  // snapshot refresh: tiles re-read their terminal buffers on a slow heartbeat
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = window.setInterval(() => setTick(t => t + 1), 1500)
    return () => window.clearInterval(iv)
  }, [])

  // Deck keyboard: ⌘1–9 stage the nth tile, ⌘⇧]/⌘⇧[ cycle the stage through
  // the rail, ⌘⇧A resumes auto-follow, ⌘J toggles the staged session's quick
  // shell. ⌘ variants only — inside a staged terminal, plain keys and Ctrl
  // belong to the CLI. Refs keep the single listener stable across renders.
  const keysRef = useRef<{ order: string[]; stagedId: string | null }>({ order: [], stagedId: null })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return
      const { order, stagedId } = keysRef.current
      if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
        const id = order[Number(e.key) - 1]
        if (id) { e.preventDefault(); setPinned(id) }
      } else if (e.shiftKey && (e.key === ']' || e.key === '}' || e.key === '[' || e.key === '{')) {
        e.preventDefault()
        const dir = e.key === ']' || e.key === '}' ? 1 : -1
        const at = Math.max(0, order.indexOf(stagedId ?? ''))
        const next = order[(at + dir + order.length) % order.length]
        if (next) setPinned(next)
      } else if (e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setPinned(null)
      } else if (!e.shiftKey && e.key.toLowerCase() === 'j' && stagedId) {
        e.preventDefault()
        requestQuickShellToggle(stagedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const sessions = useMemo(() => {
    // this workspace's sessions only — the deck is a lens on the active
    // workspace, exactly like the Work view
    const live = s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
    // stable sort: priority desc, ties keep store order (creation order)
    return [...live].sort((a, b) => priority(b) - priority(a))
  }, [s.agents, s.activeWorkspace])

  // decisions waiting in OTHER workspaces — one glanceable chip, one click away
  const elsewhere = useMemo(() => {
    const others = s.agents.filter(a => !a.archived && a.status === 'needs'
      && (a.workspaceId ?? s.activeWorkspace) !== s.activeWorkspace)
    return { count: others.length, firstWs: others[0]?.workspaceId }
  }, [s.agents, s.activeWorkspace])

  const wsLabel = s.workspaces.find(w => w.id === s.activeWorkspace)?.name ?? 'workspace'

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
  // feed the stable keyboard listener the current rail order + stage
  keysRef.current = { order: sessions.map(a => a.id), stagedId: staged?.id ?? null }
  // while pinned, decisions may be piling up behind the pin — make AUTO call out
  const autoHasNews = !auto && needs > 0

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
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--mut)', letterSpacing: 0.6, border: '1px solid var(--line2)', borderRadius: 5, padding: '2px 8px', whiteSpace: 'nowrap', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {wsLabel.toUpperCase()}
        </span>
        {latestEvent ? (
          <span className="mono" style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 9.5, color: 'var(--dim)', letterSpacing: 0.3, overflow: 'hidden' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: EVENT_COLORS[latestEvent.type] || 'var(--mut)' }} />
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {latestEvent.time} · {latestEvent.text}
            </span>
          </span>
        ) : (
          <span className="mono" style={{ flex: 1, fontSize: 9.5, color: 'var(--faint)', letterSpacing: 0.6 }}>ONE CHANNEL · THE DECK FOLLOWS THE ACTION</span>
        )}
        {elsewhere.count > 0 && (
          <button
            className="mono"
            title="Sessions in other workspaces are waiting on you — click to switch to the first one"
            onClick={() => { if (elsewhere.firstWs) switchWorkspace(elsewhere.firstWs) }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'var(--amber)',
              background: 'rgba(255,176,32,.08)', border: '1px solid var(--amber)', borderRadius: 6, padding: '3px 9px',
              animation: 'cattn 2.6s ease-in-out infinite',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', animation: 'cpulse 1.4s ease-in-out infinite' }} />
            {elsewhere.count} ELSEWHERE →
          </button>
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
                  title={auto
                    ? 'Auto-following priority: decisions first, then running work. Click a tile (or ⌘1–9) to pin one; ⌘⇧A returns here.'
                    : autoHasNews ? 'Decisions are waiting behind your pin — ⌘⇧A resumes auto-following' : 'Pinned by you — click (or ⌘⇧A) to resume auto-following'}
                  onClick={() => setPinned(null)}
                  style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.6, cursor: 'pointer', borderRadius: 5, padding: '2px 8px',
                    background: auto ? 'rgba(61,220,151,.12)' : autoHasNews ? 'rgba(255,176,32,.1)' : 'transparent',
                    border: `1px solid ${auto ? 'var(--green)' : autoHasNews ? 'var(--amber)' : 'var(--line2)'}`,
                    color: auto ? 'var(--green)' : autoHasNews ? 'var(--amber)' : 'var(--mut)',
                    animation: autoHasNews ? 'cattn 2.6s ease-in-out infinite' : 'none',
                  }}
                >
                  {auto ? '◉ AUTO' : autoHasNews ? `⊙ PINNED · ${needs} waiting` : '⊙ PINNED — resume auto'}
                </button>
                <div style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 8.5, color: 'var(--faint)', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>
                  ⌘1–9 stage · ⌘⇧] next · ⌘⇧A auto · ⌘J shell
                </span>
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
                  ? 'No live sessions. Ask Master in the sidebar chat, or launch one from the Work view.'
                  : 'No live sessions. Launch one from the Work view — the deck lights up as sessions run.'}
              </div>
            </div>
          )}

          {/* ── the rail: live tiles first, idle sessions as quiet chips ── */}
          {sessions.length > 1 && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--line)', background: 'var(--bg2)', ...DECK_GRID }}>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 10, padding: 10, overflowX: 'auto' }}>
                {sessions.filter(a => a.status !== 'idle').map(a => (
                  <SessionTile
                    key={a.id}
                    agent={a}
                    ix={sessions.indexOf(a)}
                    esc={escByAgent.get(a.id)}
                    staged={stagedList.some(x => x.id === a.id)}
                    onStage={() => setPinned(a.id)}
                  />
                ))}
                {sessions.some(a => a.status === 'idle') && (
                  <div style={{
                    display: 'flex', flexDirection: 'column', flexWrap: 'wrap', alignContent: 'flex-start',
                    gap: 6, maxHeight: 150, padding: '2px 0', flexShrink: 0,
                  }}>
                    <span className="mono" style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: 'var(--faint)', padding: '2px 2px 0' }}>QUIET</span>
                    {sessions.filter(a => a.status === 'idle').map(a => (
                      <QuietChip
                        key={a.id}
                        agent={a}
                        ix={sessions.indexOf(a)}
                        staged={stagedList.some(x => x.id === a.id)}
                        onStage={() => setPinned(a.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
