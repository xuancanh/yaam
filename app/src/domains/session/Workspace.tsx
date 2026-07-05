import { useState } from 'react'
import { useActions, useConductor } from '../../store'
import { ACCENT, hexToRgba, indicatorColor } from '../../core/data'
import type { Agent, TabGroup } from '../../core/types'
import { IC, Icon, StatusPill } from '../../components/ui'
import { NewSessionDialog } from './NewSessionDialog'
import { Divider } from './Divider'
import { Pane } from './Pane'

type LayoutKey = '1' | '2col' | '2row' | '3' | '4'

const LAYOUTS: { key: LayoutKey; n: number; stacked?: boolean; label: string; hint: string }[] = [
  { key: '1', n: 1, label: 'Single', hint: '1 session' },
  { key: '2col', n: 2, label: 'Split vertical', hint: 'side by side' },
  { key: '2row', n: 2, stacked: true, label: 'Split horizontal', hint: 'top / bottom' },
  { key: '3', n: 3, label: 'Three panes', hint: '2 top · 1 bottom' },
  { key: '4', n: 4, label: 'Grid', hint: '2 × 2' },
]

/** Layout key describing a group's current pane arrangement. */
function layoutKeyOf(g: TabGroup): LayoutKey {
  return g.slots.length === 2 ? (g.stacked ? '2row' : '2col') : String(Math.max(1, Math.min(4, g.slots.length))) as LayoutKey
}

/** Draw a compact visual preview for one terminal-pane layout. */
function LayoutGlyph({ k, color }: { k: LayoutKey; color: string }) {
  const cells: [number, number, number, number][] =
    k === '1' ? [[1, 1, 20, 14]]
    : k === '2col' ? [[1, 1, 9, 14], [12, 1, 9, 14]]
    : k === '2row' ? [[1, 1, 20, 6], [1, 9, 20, 6]]
    : k === '3' ? [[1, 1, 9, 6.5], [12, 1, 9, 6.5], [1, 9.5, 20, 5.5]]
    : [[1, 1, 9, 6.5], [12, 1, 9, 6.5], [1, 9.5, 9, 5.5], [12, 9.5, 9, 5.5]]
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" style={{ flexShrink: 0 }}>
      {cells.map((c, i) => (
        <rect key={i} x={c[0]} y={c[1]} width={c[2]} height={c[3]} rx="1.5"
          fill="none" stroke={color} strokeWidth="1.4" />
      ))}
    </svg>
  )
}

/** Chrome-like split button: choose the ACTIVE group's pane layout (1–4 sessions). */
function LayoutMenu({ group }: { group: TabGroup | undefined }) {
  const { setPaneLayout } = useActions()
  const [open, setOpen] = useState(false)
  const current: LayoutKey = group ? layoutKeyOf(group) : '1'
  const split = (group?.slots.length ?? 1) > 1

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className="icon-btn"
        title="Pane layout (applies to the current tab group)"
        onClick={() => setOpen(o => !o)}
        style={{
          width: 38, height: 30, gap: 3,
          background: split || open ? hexToRgba(ACCENT, 0.14) : 'transparent',
          color: split || open ? 'var(--accent)' : '#9AA3B2',
        }}
      >
        <LayoutGlyph k={current} color="currentColor" />
        <span style={{ fontSize: 8, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div style={{
            position: 'absolute', top: 34, right: 0, width: 210, background: 'var(--panel2)',
            border: '1px solid var(--line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            zIndex: 45, overflow: 'hidden', padding: 6,
          }}>
            <div className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)', padding: '5px 10px 6px' }}>
              PANE LAYOUT · THIS TAB
            </div>
            {LAYOUTS.map(l => {
              const active = l.key === current
              return (
                <button
                  key={l.key}
                  className={active ? '' : 'palette-item'}
                  onClick={() => { setPaneLayout(l.n, l.stacked); setOpen(false) }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                    background: active ? 'rgba(245,196,81,.08)' : 'transparent', border: 'none', borderRadius: 8,
                    color: active ? 'var(--accent)' : 'var(--text)', textAlign: 'left',
                  }}
                >
                  <LayoutGlyph k={l.key} color={active ? 'var(--accent)' : '#9AA3B2'} />
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{l.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{l.hint}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** empty grid section: click to pick which session lives here */
function EmptySlot({ index }: { index: number }) {
  const s = useConductor()
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
        alignItems: 'center', justifyContent: 'center', background: '#0A0B0F', cursor: 'pointer',
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

/** Compose group/loose tabs, the active group's split grid, and the dock. */
export function Workspace() {
  const s = useConductor()
  const { focusTab, activateGroup, closeGroup, openNewSession, closeNewSession, restoreSession, setRowSplit, setColSplit } = useActions()
  const byId = new Map(s.agents.map(a => [a.id, a]))
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
  const stacked2 = cells.length === 2 && (ag?.stacked ?? false)
  const rows = stacked2 ? [[cells[0]], [cells[1]]]
    : cells.length <= 2 ? [cells] : [cells.slice(0, 2), cells.slice(2)]

  const wsAgents = s.agents.filter(a => !a.archived && a.kind !== 'chat' && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
  const minimized = s.minimizedIds.map(id => byId.get(id)).filter((a): a is Agent => !!a)
  const inAnyGroup = new Set(s.groups.flatMap(g => g.slots).filter(Boolean))
  const looseTabs = wsAgents.filter(a => !inAnyGroup.has(a.id))

  const tabDot = (a: Agent) => {
    const flash = a.status === 'needs' || a.attention
    return (
      <span style={{
        width: flash ? 9 : 8, height: flash ? 9 : 8, borderRadius: '50%',
        background: indicatorColor(a), flexShrink: 0,
        animation: flash ? 'cpulse 1.1s ease-in-out infinite' : 'none',
        boxShadow: flash ? `0 0 7px ${indicatorColor(a)}` : 'none',
      }} />
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        height: 46, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px',
      }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
          {s.groups.map(g => {
            const members = g.slots
              .map((id, slot) => ({ agent: id ? byId.get(id) : undefined, slot }))
              .filter((m): m is { agent: Agent; slot: number } => !!m.agent)
            const activeG = g.id === s.activeGroup
            // single sessions render as plain tabs; real splits as merged pills
            if (members.length <= 1) {
              const a = members[0]?.agent
              if (!a && !activeG) return null
              return (
                <button
                  key={g.id}
                  className="tab-btn"
                  onClick={() => (a ? focusTab(a.id) : activateGroup(g.id))}
                  style={{
                    background: activeG ? 'var(--panel2)' : 'transparent',
                    borderTop: `2px solid ${activeG ? (a?.color ?? 'var(--line2)') : 'transparent'}`,
                  }}
                >
                  {a ? tabDot(a) : <LayoutGlyph k={layoutKeyOf(g)} color="var(--dim)" />}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: activeG ? 'var(--text)' : '#9AA3B2', whiteSpace: 'nowrap' }}>
                    {a?.name ?? `empty · ${g.slots.length} pane${g.slots.length > 1 ? 's' : ''}`}
                  </span>
                  {a && <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{a.repo}</span>}
                  {a && <StatusPill agent={a} small />}
                </button>
              )
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
                  <LayoutGlyph k={layoutKeyOf(g)} color="currentColor" />
                </span>
                {members.map(({ agent: a, slot }) => {
                  const active = activeG && slot === g.activePane
                  return (
                    <button
                      key={a.id}
                      onClick={e => { e.stopPropagation(); focusTab(a.id) }}
                      title={`${a.name} · ${a.repo}`}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 7,
                        background: active ? hexToRgba(a.color, 0.16) : 'transparent', border: 'none',
                      }}
                    >
                      {tabDot(a)}
                      <span style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--text)' : '#9AA3B2', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <StatusPill agent={a} small />
                    </button>
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
            <button
              key={a.id}
              className="tab-btn"
              title="Open this session"
              onClick={() => focusTab(a.id)}
              style={{ background: 'transparent', borderTop: '2px solid transparent' }}
            >
              {tabDot(a)}
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#9AA3B2', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{a.repo}</span>
              <StatusPill agent={a} small />
            </button>
          ))}
        </div>
        <LayoutMenu group={ag} />
        <button className="icon-btn" title="New agent session" onClick={openNewSession} style={{ width: 30, height: 30, flexShrink: 0, color: '#9AA3B2' }}>
          <Icon paths={IC.plus} size={17} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--line)' }}>
        {wsAgents.length === 0 && s.groups.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: '#0A0B0F' }}>
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
              {ri > 0 && <Divider dir="row" onRatio={setRowSplit} />}
              <div style={{
                display: 'flex', minHeight: 0,
                flexBasis: rows.length === 1 ? '100%' : `${(ri === 0 ? splits.row : 1 - splits.row) * 100}%`,
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
                title="Restore from dock"
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
