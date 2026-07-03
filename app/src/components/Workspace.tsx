import { useEffect, useMemo, useRef, useState } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT, STATUS_META, hexToRgba, memTokens } from '../data'
import { isTauri, pickFolder } from '../native'
import { fitTerminal, getTerminal } from '../terminals'
import type { Agent } from '../types'
import { AgentAvatar, EditableName, IC, Icon, StatusPill } from './ui'

export const SHELLS = ['zsh', 'bash', 'sh', 'fish', 'nu']

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
} as const

function FieldLabel({ children }: { children: string }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', marginBottom: 5, letterSpacing: 0.3 }}>{children}</div>
}

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const s = useConductor()
  const { newRealSession } = useActions()
  const enabledTypes = useMemo(() => s.agentTypes.filter(t => t.enabled), [s.agentTypes])
  const [typeId, setTypeId] = useState(enabledTypes[0]?.id ?? 'shell')
  const [shell, setShell] = useState(s.settings.shell || 'zsh')
  const [command, setCommand] = useState(enabledTypes[0]?.model ?? '')
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')

  const isShell = typeId === 'shell'
  const isCustom = typeId === 'custom'
  const effectiveCommand = isShell ? `${shell} -i` : command

  const selectType = (id: string) => {
    setTypeId(id)
    if (id === 'custom') setCommand('')
    else if (id !== 'shell') {
      const t = s.agentTypes.find(x => x.id === id)
      if (t) setCommand(t.model)
    }
  }

  const browse = async () => {
    const dir = await pickFolder(cwd || undefined)
    if (dir) setCwd(dir)
  }

  const launch = () => {
    if (!effectiveCommand.trim()) return
    newRealSession(effectiveCommand, cwd)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '15vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 500, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New agent session</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          {isTauri
            ? 'Pick an agent type or a plain terminal — output streams into a workspace pane, input goes to its stdin.'
            : 'Sessions need the desktop app — this browser build cannot spawn processes.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <FieldLabel>Agent type</FieldLabel>
            <select value={typeId} onChange={e => selectType(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
              {enabledTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="shell">Terminal</option>
              <option value="custom">Custom command…</option>
            </select>
          </div>
          {isShell ? (
            <div>
              <FieldLabel>Shell</FieldLabel>
              <select value={shell} onChange={e => setShell(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <FieldLabel>Command</FieldLabel>
              <input
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch() }}
                placeholder={isCustom ? 'e.g. python3 -i, node, htop' : 'command'}
                disabled={!isTauri}
                style={FIELD_STYLE}
              />
            </div>
          )}
          <div>
            <FieldLabel>Working directory</FieldLabel>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch() }}
                placeholder="folder (optional)"
                disabled={!isTauri}
                style={FIELD_STYLE}
              />
              <button className="open-btn" style={{ flex: 'none', padding: '0 14px' }} onClick={browse} disabled={!isTauri}>
                Browse…
              </button>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, opacity: isTauri && effectiveCommand.trim() ? 1 : 0.45 }}
            onClick={launch}
            disabled={!isTauri || !effectiveCommand.trim()}
          >
            Launch {effectiveCommand.trim() && <span className="mono" style={{ fontWeight: 400, opacity: 0.75 }}>· {effectiveCommand.trim().slice(0, 28)}</span>}
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function TerminalPane({ agent, active }: { agent: Agent; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { term } = getTerminal(agent.id)
    if (!term.element) term.open(el)
    else el.appendChild(term.element)
    // fit after layout settles — fitting synchronously on reattach measures a
    // zero-height container and breaks the viewport (no scroll, no cursor)
    const raf = requestAnimationFrame(() => {
      fitTerminal(agent.id)
      try { term.refresh(0, term.rows - 1) } catch { /* not measurable yet */ }
    })
    const ro = new ResizeObserver(() => fitTerminal(agent.id))
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [agent.id])

  useEffect(() => {
    if (active) getTerminal(agent.id).term.focus()
  }, [active, agent.id])

  return (
    <div
      ref={ref}
      onMouseDown={() => getTerminal(agent.id).term.focus()}
      style={{
        flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden',
        background: '#0A0B0F', padding: '8px 2px 2px 10px',
      }}
    />
  )
}

function Divider({ dir, onRatio }: { dir: 'col' | 'row'; onRatio: (r: number) => void }) {
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    // walk past display:contents wrappers, which have no box
    let parent = e.currentTarget.parentElement
    while (parent) {
      const r = parent.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) break
      parent = parent.parentElement
    }
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    const move = (ev: MouseEvent) => {
      const raw = dir === 'col'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      onRatio(Math.min(0.85, Math.max(0.15, raw)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div
      className="pane-divider"
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        ...(dir === 'col' ? { width: 5, cursor: 'col-resize' } : { height: 5, cursor: 'row-resize' }),
      }}
    />
  )
}

function Pane({ agent, index, active, showRing, maximized }: { agent: Agent; index: number; active: boolean; showRing: boolean; maximized: boolean }) {
  const { setActivePane, closePane, openPanel, resume, approve, deny, stopSession, toggleMaximize, minimizePane, renameSession } = useActions()
  const memOn = agent.memory.filter(m => m.on)
  const memTotal = memOn.reduce((n, m) => n + memTokens(agent, m.id), 0)
  const toolCount = agent.tools.filter(t => t.on).length

  return (
    <div
      onClick={() => setActivePane(index)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        background: '#0A0B0F', boxShadow: showRing && active ? `inset 0 0 0 1.5px ${ACCENT}` : 'none',
        position: 'relative',
      }}
    >
      <div style={{
        height: 42, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 9, padding: '0 11px',
      }}>
        <AgentAvatar agent={agent} />
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <EditableName name={agent.name} onRename={name => renameSession(agent.id, name)} fontSize={12.5} />
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.repo} · {agent.branch}
          </div>
        </div>
        <div style={{ marginLeft: 6 }}>
          <StatusPill agent={agent} />
        </div>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="Memory & context" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); openPanel(agent.id, 'memory') }}>
          <Icon paths={['M7 7h10v10H7z', ...IC.chip]} size={15} />
        </button>
        <button className="icon-btn" title="Tools & permissions" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); openPanel(agent.id, 'tools') }}>
          <Icon paths={[...IC.sliders, 'M6 9m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M12 15m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M18 7m-2 0a2 2 0 104 0 2 2 0 10-4 0']} size={15} />
        </button>
        {(agent.status === 'idle' || agent.status === 'error') && (
          <button className="icon-btn" title="Resume session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--green)' }} onClick={e => { e.stopPropagation(); resume(agent.id) }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
          </button>
        )}
        {agent.kind === 'real' && agent.status === 'running' && (
          <button className="icon-btn" title="Stop session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--red-soft)' }} onClick={e => { e.stopPropagation(); stopSession(agent.id) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        )}
        <button className="icon-btn" title="Minimize to dock" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); minimizePane(index) }}>
          <Icon paths={['M5 19h14']} size={14} stroke={1.8} />
        </button>
        <button className="icon-btn" title={maximized ? 'Restore grid' : 'Maximize pane'} style={{ width: 27, height: 27, borderRadius: 7, color: maximized ? 'var(--accent)' : undefined }} onClick={e => { e.stopPropagation(); toggleMaximize(index) }}>
          {maximized
            ? <Icon paths={['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5']} size={14} stroke={1.8} />
            : <Icon paths={['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']} size={14} stroke={1.8} />}
        </button>
        <button className="icon-btn danger" title="Close pane" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); closePane(index) }}>
          <Icon paths={IC.close} size={14} stroke={1.8} />
        </button>
      </div>

      <TerminalPane agent={agent} active={active} />

      {agent.status === 'needs' && (
        <div style={{
          borderTop: '1px solid rgba(255,176,32,.4)', background: 'rgba(255,176,32,.07)',
          padding: '12px 15px', display: 'flex', flexDirection: 'column', gap: 9,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)' }}>
            <Icon paths={IC.warn} size={15} stroke={1.8} />
            Blocked — waiting for your approval
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#C7CCD6' }}>{agent.escReason}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="approve-btn" style={{ padding: '7px 16px' }} onClick={e => { e.stopPropagation(); approve(agent.id) }}>Approve</button>
            <button className="deny-btn" style={{ padding: '7px 16px' }} onClick={e => { e.stopPropagation(); deny(agent.id) }}>Deny</button>
          </div>
        </div>
      )}

      <div className="mono" style={{
        height: 26, flexShrink: 0, background: 'var(--panel)', borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', fontSize: 10.5, color: 'var(--dim)',
      }}>
        <span>{agent.model}</span>
        <span>{memOn.length} memories · {memTotal.toFixed(1)}k</span>
        <span>{toolCount} tools</span>
      </div>
    </div>
  )
}

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
        {s.agents.map(a => {
          const active = focused.includes(a.id)
          const sm = STATUS_META[a.status] || STATUS_META.idle
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
                width: 8, height: 8, borderRadius: '50%', background: sm.color, flexShrink: 0,
                animation: a.status === 'running' || a.status === 'needs' ? 'cpulse 1.6s ease-in-out infinite' : 'none',
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
            const sm = STATUS_META[a.status] || STATUS_META.idle
            return (
              <button
                key={a.id}
                className="dock-chip"
                title="Restore to grid"
                onClick={() => restoreSession(a.id)}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', background: sm.color, flexShrink: 0,
                  animation: a.status === 'running' || a.status === 'needs' ? 'cpulse 1.6s ease-in-out infinite' : 'none',
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
