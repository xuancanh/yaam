import { useEffect, useMemo, useRef, useState } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT, STATUS_META, hexToRgba } from '../data'
import { isTauri, pickFolder } from '../native'
import { fitTerminal, getTerminal } from '../terminals'
import type { Agent } from '../types'
import { AgentAvatar, IC, Icon, StatusPill } from './ui'

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
    fitTerminal(agent.id)
    const ro = new ResizeObserver(() => fitTerminal(agent.id))
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [agent.id])

  useEffect(() => {
    if (active) getTerminal(agent.id).term.focus()
  }, [active, agent.id])

  return <div ref={ref} style={{ flex: 1, minHeight: 0, background: '#0A0B0F', padding: '8px 2px 2px 10px' }} />
}

function Pane({ agent, index, active, showRing }: { agent: Agent; index: number; active: boolean; showRing: boolean }) {
  const { setActivePane, closePane, openPanel, resume, approve, deny, stopSession } = useActions()
  const memOn = agent.memory.filter(m => m.on)
  const memTotal = memOn.reduce((n, m) => n + m.tokens, 0)
  const toolCount = agent.tools.filter(t => t.on).length

  return (
    <div
      onClick={() => setActivePane(index)}
      style={{
        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#0A0B0F',
        boxShadow: showRing && active ? `inset 0 0 0 1.5px ${ACCENT}` : 'none', position: 'relative',
      }}
    >
      <div style={{
        height: 42, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 9, padding: '0 11px',
      }}>
        <AgentAvatar agent={agent} />
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</div>
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
  const { focusTab, toggleSplit, openNewSession, closeNewSession } = useActions()
  const focused = s.focusedIds.slice(0, s.splitCount)
  const byId = new Map(s.agents.map(a => [a.id, a]))
  const panes = focused
    .map((id, i) => ({ agent: byId.get(id) || s.agents[0], i }))
    .filter((p): p is { agent: Agent; i: number } => !!p.agent)

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
          title="Toggle split view"
          onClick={toggleSplit}
          style={{
            width: 30, height: 30, flexShrink: 0,
            background: s.splitCount > 1 ? hexToRgba(ACCENT, 0.14) : 'transparent',
            color: s.splitCount > 1 ? 'var(--accent)' : '#9AA3B2',
          }}
        >
          <Icon paths={['M4 5h16v14H4z', 'M12 5v14']} size={17} />
        </button>
        <button className="icon-btn" title="New agent session" onClick={openNewSession} style={{ width: 30, height: 30, flexShrink: 0, color: '#9AA3B2' }}>
          <Icon paths={IC.plus} size={17} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 1, background: 'var(--line)' }}>
        {panes.length === 0 ? (
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
          panes.map(({ agent, i }) => (
            <Pane key={`${agent.id}-${i}`} agent={agent} index={i} active={i === s.activePane} showRing={s.splitCount > 1} />
          ))
        )}
      </div>
      {s.newSessionOpen && <NewSessionDialog onClose={closeNewSession} />}
    </div>
  )
}
