import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { ACCENT, hexToRgba, indicatorColor, RESPONDING_COLOR } from '../../core/data'
import type { Agent, BoardTask, TabGroup } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { RunControl } from '../board/RunControl'
import { NewSessionDialog } from './NewSessionDialog'
import { Divider } from './Divider'
import { groupRows, LAYOUT_VARIANTS } from './layout-state'
import { MOVE_MENU_EDGE, MOVE_MENU_WIDTH, sessionMoveMenuPlacement } from './move-menu'
import { Pane } from './Pane'
import { SessionHoverPreview } from './SessionHoverPreview'

/** Draw a compact visual preview of a row partition (panes per row). */
function LayoutGlyph({ rows, color }: { rows: number[]; color: string }) {
  const W = 22, H = 16, GAP = 1.6, PAD = 1
  const rowH = (H - 2 * PAD - (rows.length - 1) * GAP) / rows.length
  const cells: [number, number, number, number][] = []
  rows.forEach((cols, ri) => {
    const cw = (W - 2 * PAD - (cols - 1) * GAP) / cols
    for (let ci = 0; ci < cols; ci++) {
      cells.push([PAD + ci * (cw + GAP), PAD + ri * (rowH + GAP), cw, rowH])
    }
  })
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" style={{ flexShrink: 0 }}>
      {cells.map((c, i) => (
        <rect key={i} x={c[0]} y={c[1]} width={c[2]} height={c[3]} rx="1.5"
          fill="none" stroke={color} strokeWidth="1.3" />
      ))}
    </svg>
  )
}

const sameRows = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])

interface TabMenuState { x: number; y: number; agent: Agent }

/** Right-click menu for a session tab: re-home the session into another
 *  workspace (its process keeps running; it arrives there as a loose tab). */
function TabContextMenu({ menu, onClose }: { menu: TabMenuState; onClose: () => void }) {
  const s = useConductorSelector(x => ({ workspaces: x.workspaces, activeWorkspace: x.activeWorkspace, detachedWorkspaces: x.detachedWorkspaces }), shallowEqual)
  const { moveSessionToWorkspace } = useActions()
  const firstTarget = useRef<HTMLButtonElement>(null)
  const sourceWorkspace = menu.agent.workspaceId ?? s.activeWorkspace
  const targets = s.workspaces.filter(w => w.id !== sourceWorkspace)
  const detached = new Set(s.detachedWorkspaces ?? [])
  const firstAvailable = targets.findIndex(w => !detached.has(w.id))
  const placement = sessionMoveMenuPlacement(menu.x, menu.y, targets.length, window.innerWidth, window.innerHeight)

  useEffect(() => {
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', onClose)
    firstTarget.current?.focus()
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal((
    <>
      <div
        aria-hidden="true"
        style={{ position: 'fixed', inset: 0, zIndex: 60 }}
        onPointerDown={onClose}
        onContextMenu={e => { e.preventDefault(); onClose() }}
      />
      <div
        role="menu"
        aria-label={`Move ${menu.agent.name} to workspace`}
        onContextMenu={e => e.preventDefault()}
        style={{
        position: 'fixed', top: placement.top, left: placement.left, zIndex: 61,
        width: MOVE_MENU_WIDTH, maxWidth: `calc(100vw - ${MOVE_MENU_EDGE * 2}px)`, maxHeight: placement.maxHeight,
        background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 10,
        padding: 4, boxShadow: '0 8px 28px rgba(0,0,0,.35)', overflow: 'hidden',
      }}>
        <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, color: 'var(--dim)', padding: '5px 10px 3px' }}>
          MOVE TO WORKSPACE
        </div>
        {targets.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--dim)', padding: '6px 10px' }}>No other workspaces</div>
        )}
        {targets.length > 0 && (
          <div style={{ overflowY: 'auto', maxHeight: `calc(${placement.maxHeight}px - 38px)` }}>
            {targets.map((w, index) => {
              const unavailable = detached.has(w.id)
              return (
                <button
                  key={w.id}
                  ref={index === firstAvailable ? firstTarget : undefined}
                  role="menuitem"
                  disabled={unavailable}
                  className="palette-item"
                  title={unavailable ? 'Reattach this workspace window before moving a session into it' : `Move to ${w.name}`}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    background: 'transparent', border: 'none', textAlign: 'left', padding: '7px 10px',
                    borderRadius: 7, fontSize: 12, color: unavailable ? 'var(--dim)' : 'var(--text)',
                    cursor: unavailable ? 'not-allowed' : 'pointer', opacity: unavailable ? 0.65 : 1,
                  }}
                  onClick={() => {
                    if (unavailable) return
                    onClose()
                    moveSessionToWorkspace(menu.agent.id, w.id)
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: w.color ?? 'var(--dim)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                  {unavailable && <span className="mono" style={{ flexShrink: 0, fontSize: 9, color: 'var(--faint)' }}>SEPARATE WINDOW</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </>
  ), document.body)
}

/** Chrome-like split button: choose the ACTIVE group's pane layout. Two levels:
 *  pick the pane count (1–6), then the arrangement variant for that count. */
function LayoutMenu({ group }: { group: TabGroup | undefined }) {
  const { setPaneLayout } = useActions()
  const [open, setOpen] = useState(false)
  const currentRows = group ? groupRows(group) : [1]
  const currentCount = group?.slots.length ?? 1
  // the count whose variants are on display; resyncs to the group on open
  const [selCount, setSelCount] = useState(currentCount)
  const split = currentCount > 1
  const variants = LAYOUT_VARIANTS[selCount] ?? LAYOUT_VARIANTS[1]

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className="icon-btn"
        title="Pane layout (applies to the current tab group)"
        onClick={() => { setSelCount(currentCount); setOpen(o => !o) }}
        style={{
          width: 38, height: 30, gap: 3,
          background: split || open ? hexToRgba(ACCENT, 0.14) : 'transparent',
          color: split || open ? 'var(--accent)' : 'var(--mut2)',
        }}
      >
        <LayoutGlyph rows={currentRows} color="currentColor" />
        <span style={{ fontSize: 8, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div style={{
            position: 'absolute', top: 34, right: 0, width: 188, background: 'var(--panel2)',
            border: '1px solid var(--line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            zIndex: 45, overflow: 'hidden', padding: 8,
          }}>
            <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '3px 6px 6px' }}>
              PANES · THIS TAB
            </div>
            <div style={{ display: 'flex', gap: 3, padding: '0 2px 8px' }}>
              {[1, 2, 3, 4, 5, 6].map(n => {
                const isCur = n === currentCount
                const isSel = n === selCount
                return (
                  <button
                    key={n}
                    className={isSel ? '' : 'palette-item'}
                    title={`${n} pane${n > 1 ? 's' : ''}`}
                    // picking a count applies its default variant right away;
                    // the variants below refine it
                    onClick={() => {
                      setSelCount(n)
                      if (n !== currentCount) setPaneLayout(LAYOUT_VARIANTS[n][0].rows)
                    }}
                    style={{
                      flex: 1, height: 26, border: '1px solid ' + (isSel ? 'var(--accent)' : 'var(--line2)'),
                      borderRadius: 7, background: isSel ? 'rgba(245,196,81,.10)' : 'transparent',
                      color: isCur ? 'var(--accent)' : isSel ? 'var(--text)' : 'var(--mut2)',
                      fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    {n}
                  </button>
                )
              })}
            </div>
            <div className="mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.4, color: 'var(--faint)', padding: '0 6px 5px' }}>
              ARRANGEMENT
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(variants.length, 4)}, 1fr)`, gap: 3 }}>
              {variants.map(v => {
                const active = selCount === currentCount && sameRows(v.rows, currentRows)
                return (
                  <button
                    key={v.rows.join('-')}
                    className={active ? '' : 'palette-item'}
                    title={v.label}
                    aria-label={v.label}
                    onClick={() => { setPaneLayout(v.rows); setOpen(false) }}
                    style={{
                      height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                      background: active ? 'rgba(245,196,81,.08)' : 'transparent', border: 'none', borderRadius: 8,
                      color: active ? 'var(--accent)' : 'var(--text)',
                    }}
                  >
                    <LayoutGlyph rows={v.rows} color={active ? 'var(--accent)' : 'var(--mut2)'} />
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** empty grid section: click to pick which session lives here */
function EmptySlot({ index }: { index: number }) {
  const s = useConductorSelector(x => ({ agents: x.agents, activeWorkspace: x.activeWorkspace, groups: x.groups, activeGroup: x.activeGroup }), shallowEqual)
  const { assignPane, openNewSession, setActivePane } = useActions()
  const [picking, setPicking] = useState(false)
  // assignable: loose sessions, plus sessions sitting alone in a single-pane
  // group (assigning pulls them over and dissolves the emptied group) —
  // only sessions already in the ACTIVE group are off the menu
  const available = s.agents.filter(a => {
    if (a.archived || a.kind === 'chat' || (a.workspaceId ?? s.activeWorkspace) !== s.activeWorkspace) return false
    const g = s.groups.find(x => x.slots.includes(a.id))
    if (!g) return true
    return g.id !== s.activeGroup && g.slots.filter(Boolean).length <= 1
  })

  return (
    <div
      onClick={() => setPicking(p => !p)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'var(--bg2)', cursor: 'pointer',
      }}
    >
      {!picking ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 20 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, border: '1.5px dashed var(--line2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)',
          }}>
            <Icon paths={IC.plus} size={18} stroke={1.8} />
          </div>
          <div className="grotesk" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--mut)' }}>Empty pane</div>
          <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>Click to assign a session</div>
        </div>
      ) : (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            width: 300, maxWidth: '86%', maxHeight: '82%', overflowY: 'auto', background: 'var(--panel2)',
            border: '1px solid var(--line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            padding: 6, cursor: 'default',
          }}
        >
          <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '5px 10px 6px' }}>
            ASSIGN SESSION
          </div>
          {available.map(a => (
            <button
              key={a.id}
              className="palette-item"
              onClick={() => assignPane(index, a.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px',
                background: 'transparent', border: 'none', borderRadius: 8, textAlign: 'left',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: indicatorColor(a), flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{a.repo}</span>
            </button>
          ))}
          {!available.length && (
            <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '6px 10px 8px' }}>
              All sessions already live in a tab group.
            </div>
          )}
          <button
            className="palette-item"
            onClick={() => { setActivePane(index); openNewSession(); setPicking(false) }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
              background: 'transparent', border: 'none', borderTop: '1px solid var(--line)',
              marginTop: 4, color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, borderRadius: 8,
            }}
          >
            <Icon paths={IC.plus} size={13} stroke={2} />
            New session…
          </button>
        </div>
      )}
    </div>
  )
}

/** Compose the mode toggle, group/loose tabs, the active group's split grid,
 *  and the dock — or, in Runs mode, the triage rail + session pane. */
export function Workspace() {
  const s = useConductorSelector(x => ({ agents: x.agents, tasks: x.tasks, activeWorkspace: x.activeWorkspace, groups: x.groups, activeGroup: x.activeGroup, minimizedIds: x.minimizedIds, newSessionOpen: x.newSessionOpen, workMode: x.settings.workMode ?? 'tabs' }), shallowEqual)
  const { focusTab, activateGroup, closeGroup, openNewSession, closeNewSession, restoreSession, setRowSplit, setColSplit, updateSettings } = useActions()
  const runsMode = s.workMode === 'runs'
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const closeTabMenu = useCallback(() => setTabMenu(null), [])
  const openTabMenu = (e: MouseEvent, a: Agent) => {
    e.preventDefault()
    e.stopPropagation()
    setTabMenu({ x: e.clientX, y: e.clientY, agent: a })
  }
  const byId = new Map(s.agents.map(a => [a.id, a]))
  const taskByAgent = new Map<string, BoardTask>()
  for (const task of s.tasks) {
    if (task.archived) continue
    if (task.agentId) taskByAgent.set(task.agentId, task)
    for (const id of task.agentIds ?? []) if (!taskByAgent.has(id)) taskByAgent.set(id, task)
  }
  const ag = s.groups.find(g => g.id === s.activeGroup)
  const slots: (string | null)[] = ag?.slots ?? [null]
  const splits = ag?.splits ?? { row: 0.5, cols: [0.5, 0.5] }

  // slot → agent cells; a duplicated id degrades to an empty slot (two panes
  // would fight over the same terminal element)
  const seen = new Set<string>()
  let cells: { agent: Agent | null; i: number }[] = slots.map((id, i) => {
    const agent = (id && byId.get(id)) || null
    if (agent && seen.has(agent.id)) return { agent: null, i }
    if (agent) seen.add(agent.id)
    return { agent, i }
  })
  if (ag && ag.maximizedPane !== null && cells[ag.maximizedPane]?.agent) cells = [cells[ag.maximizedPane]]
  // partition the cells by the group's row layout (maximize collapses to one)
  const partition = ag && cells.length === ag.slots.length ? groupRows(ag) : [cells.length || 1]
  const rows: { agent: Agent | null; i: number }[][] = []
  {
    let at = 0
    for (const n of partition) {
      rows.push(cells.slice(at, at + n))
      at += n
    }
  }

  const wsAgents = s.agents.filter(a => !a.archived && a.kind !== 'chat' && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const minimized = s.minimizedIds.map(id => byId.get(id)).filter((a): a is Agent => !!a)
  const inAnyGroup = new Set(s.groups.flatMap(g => g.slots).filter(Boolean))
  const looseTabs = wsAgents.filter(a => !inAnyGroup.has(a.id))

  // With more than one tab in the bar, truncate the folder name so tabs stay a
  // consistent size instead of each stretching to its full cwd length. The full
  // path stays available in the tab's tooltip.
  const truncateRepo = s.groups.length + looseTabs.length > 1
  const repoStyle = {
    fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap' as const,
    ...(truncateRepo ? { maxWidth: 52, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, display: 'inline-block' as const } : {}),
  }

  // The dot IS the status now (no text label): its color encodes the lifecycle
  // state, and it blinks in two cases — amber/red pulse for needs-action, and a
  // sky-blue pulse while the session is actively streaming a response.
  const tabDot = (a: Agent) => {
    const flash = a.status === 'needs' || a.attention
    const responding = !flash && a.status === 'running' && !!a.responding
    const active = flash || responding
    const color = responding ? RESPONDING_COLOR : indicatorColor(a)
    return (
      <span style={{
        width: active ? 9 : 8, height: active ? 9 : 8, borderRadius: '50%',
        background: color, flexShrink: 0,
        animation: active ? 'cpulse 1.1s ease-in-out infinite' : 'none',
        boxShadow: active ? `0 0 7px ${color}` : 'none',
      }} />
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        height: 46, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px',
      }}>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 9, padding: 2, flexShrink: 0, marginRight: 4 }}>
          {([['tabs', 'Tabs'], ['runs', 'Sidebar']] as const).map(([id, label]) => (
            <button
              key={id}
              title={id === 'tabs' ? 'Tab groups & split panes' : 'Every run in one triage list — tasks and sessions, urgent first (⌘1–9 jumps)'}
              onClick={() => updateSettings({ workMode: id })}
              style={{
                border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                background: s.workMode === id ? 'var(--panel2)' : 'transparent',
                color: s.workMode === id ? 'var(--accent)' : 'var(--mut)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
          {!runsMode && <>
          {s.groups.map(g => {
            const members = g.slots
              .map((id, slot) => ({ agent: id ? byId.get(id) : undefined, slot }))
              .filter((m): m is { agent: Agent; slot: number } => !!m.agent)
            const activeG = g.id === s.activeGroup
            // single sessions render as plain tabs; real splits as merged pills
            if (members.length <= 1) {
              const a = members[0]?.agent
              if (!a && !activeG) return null
              const button = (
                <button
                  className="tab-btn"
                  aria-label={a ? `${a.name} · ${a.repo}` : undefined}
                  onClick={() => (a ? focusTab(a.id) : activateGroup(g.id))}
                  onContextMenu={a ? e => openTabMenu(e, a) : undefined}
                  style={{
                    background: activeG ? 'var(--panel2)' : 'transparent',
                    borderTop: `2px solid ${activeG ? (a?.color ?? 'var(--line2)') : 'transparent'}`,
                  }}
                >
                  {a ? tabDot(a) : <LayoutGlyph rows={groupRows(g)} color="var(--dim)" />}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: activeG ? 'var(--text)' : 'var(--mut2)', whiteSpace: 'nowrap' }}>
                    {a?.name ?? `empty · ${g.slots.length} pane${g.slots.length > 1 ? 's' : ''}`}
                  </span>
                  {a && <span className="mono" style={repoStyle}>{a.repo}</span>}
                </button>
              )
              return a
                ? <SessionHoverPreview key={g.id} agent={a} task={taskByAgent.get(a.id)}>{button}</SessionHoverPreview>
                : <span key={g.id} style={{ display: 'contents' }}>{button}</span>
            }
            return (
              <div
                key={g.id}
                onClick={() => { if (!activeG) activateGroup(g.id) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, padding: '0 4px 0 8px',
                  height: 34, background: activeG ? 'var(--panel2)' : 'transparent', borderRadius: 9,
                  border: `1px solid ${activeG ? hexToRgba(ACCENT, 0.35) : 'var(--line2)'}`,
                  cursor: activeG ? 'default' : 'pointer',
                }}
              >
                <span title={`Split view · ${members.length} sessions`} style={{ color: activeG ? 'var(--accent)' : 'var(--dim)', display: 'flex', marginRight: 4 }}>
                  <LayoutGlyph rows={groupRows(g)} color="currentColor" />
                </span>
                {members.map(({ agent: a, slot }) => {
                  const active = activeG && slot === g.activePane
                  return (
                    <SessionHoverPreview key={a.id} agent={a} task={taskByAgent.get(a.id)}>
                    <button
                      key={a.id}
                      onClick={e => { e.stopPropagation(); focusTab(a.id) }}
                      onContextMenu={e => openTabMenu(e, a)}
                      aria-label={`${a.name} · ${a.repo}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 7,
                        background: active ? hexToRgba(a.color, 0.16) : 'transparent', border: 'none',
                      }}
                    >
                      {tabDot(a)}
                      <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--text)' : 'var(--mut2)', whiteSpace: 'nowrap' }}>{a.name}</span>
                    </button>
                    </SessionHoverPreview>
                  )
                })}
                <button
                  className="icon-btn"
                  title="Dissolve group (sessions return to plain tabs)"
                  style={{ width: 20, height: 20, borderRadius: 5, marginLeft: 2 }}
                  onClick={e => { e.stopPropagation(); closeGroup(g.id) }}
                >
                  <Icon paths={IC.close} size={10} stroke={2} />
                </button>
              </div>
            )
          })}
          {looseTabs.map(a => (
            <SessionHoverPreview key={a.id} agent={a} task={taskByAgent.get(a.id)}>
            <button
              className="tab-btn"
              aria-label={`${a.name} · ${a.repo}`}
              onClick={() => focusTab(a.id)}
              onContextMenu={e => openTabMenu(e, a)}
              style={{ background: 'transparent', borderTop: '2px solid transparent' }}
            >
              {tabDot(a)}
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--mut2)', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span className="mono" style={repoStyle}>{a.repo}</span>
            </button>
            </SessionHoverPreview>
          ))}
          </>}
        </div>
        {!runsMode && <LayoutMenu group={ag} />}
        <button className="icon-btn" title="New agent session" onClick={openNewSession} style={{ width: 30, height: 30, flexShrink: 0, color: 'var(--mut2)' }}>
          <Icon paths={IC.plus} size={17} stroke={1.8} />
        </button>
      </div>

      {runsMode ? <RunControl /> : (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--line)' }}>
        {wsAgents.length === 0 && s.groups.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: 'var(--bg2)' }}>
            <div className="grotesk" style={{ fontSize: 17, fontWeight: 600, color: 'var(--mut)' }}>No sessions yet</div>
            <div style={{ fontSize: 12.5, color: 'var(--dim)', maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
              Launch any CLI as a live session — Claude Code, Codex, Aider, a REPL, or a plain shell.
            </div>
            <button className="approve-btn" style={{ padding: '9px 22px', fontSize: 13 }} onClick={openNewSession}>
              New agent session
            </button>
          </div>
        ) : (
          rows.map((row, ri) => (
            <div key={ri} style={{ display: 'contents' }}>
              {/* the drag divider only exists for 2-row layouts (one ratio);
                  3-row layouts get equal thirds with a static seam */}
              {ri > 0 && rows.length === 2 && <Divider dir="row" onRatio={setRowSplit} />}
              {ri > 0 && rows.length !== 2 && <div style={{ height: 1, flexShrink: 0 }} />}
              <div style={{
                display: 'flex', minHeight: 0,
                flexBasis: rows.length === 1 ? '100%'
                  : rows.length === 2 ? `${(ri === 0 ? splits.row : 1 - splits.row) * 100}%`
                  : `${100 / rows.length}%`,
                flexGrow: 0, flexShrink: 1,
              }}>
                {row.map(({ agent, i }, ci) => {
                  const ratio = splits.cols[ri] ?? 0.5
                  const width = row.length === 1 ? '100%'
                    : row.length === 2 ? `${(ci === 0 ? ratio : 1 - ratio) * 100}%`
                    : `${100 / row.length}%`
                  return (
                    <div key={`${agent?.id ?? 'empty'}-${i}`} style={{ display: 'contents' }}>
                      {ci > 0 && row.length === 2 && <Divider dir="col" onRatio={r => setColSplit(ri, r)} />}
                      {ci > 0 && row.length !== 2 && <div style={{ width: 1, flexShrink: 0 }} />}
                      <div style={{ width, minWidth: 0, display: 'flex' }}>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          {agent ? (
                            <Pane
                              agent={agent}
                              index={i}
                              active={i === (ag?.activePane ?? 0)}
                              showRing={cells.length > 1}
                              maximized={ag?.maximizedPane === i}
                            />
                          ) : (
                            <EmptySlot index={i} />
                          )}
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
      )}
      {!runsMode && minimized.length > 0 && (
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
                title="Restore from dock"
                onClick={() => restoreSession(a.id)}
                onContextMenu={e => openTabMenu(e, a)}
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
      {tabMenu && <TabContextMenu menu={tabMenu} onClose={closeTabMenu} />}
      {s.newSessionOpen && <NewSessionDialog onClose={closeNewSession} />}
    </div>
  )
}
