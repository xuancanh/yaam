import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT, LOG_COLORS, STATUS_META, hexToRgba } from '../data'
import { isTauri } from '../native'
import type { Agent } from '../types'
import { AgentAvatar, IC, Icon, StatusPill } from './ui'

function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { newSession, newRealSession } = useActions()
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const launch = () => {
    if (!command.trim()) return
    newRealSession(command, cwd)
    onClose()
  }

  const fieldStyle = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
    padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  } as const

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '18vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 480, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New agent session</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          {isTauri
            ? 'Launch any CLI as a live session — its output streams into a workspace pane and you can type to its stdin.'
            : 'Real sessions need the desktop app — running in a browser, only simulated sessions are available.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            ref={inputRef}
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') launch() }}
            placeholder="command · e.g. claude -p, python3 -i, zsh -i"
            disabled={!isTauri}
            style={fieldStyle}
          />
          <input
            value={cwd}
            onChange={e => setCwd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') launch() }}
            placeholder="working directory (optional)"
            disabled={!isTauri}
            style={fieldStyle}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, opacity: isTauri && command.trim() ? 1 : 0.45 }}
            onClick={launch}
            disabled={!isTauri || !command.trim()}
          >
            Launch
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={() => { newSession(); onClose() }}>
            Simulated demo session
          </button>
        </div>
      </div>
    </div>
  )
}

function PaneInput({ agent }: { agent: Agent }) {
  const { sendInput } = useActions()
  const [value, setValue] = useState('')

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && value.trim()) {
      sendInput(agent.id, value)
      setValue('')
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)', padding: '8px 11px', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="mono" style={{ color: 'var(--green)', fontSize: 12, flexShrink: 0 }}>❯</span>
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={onKey}
        onClick={e => e.stopPropagation()}
        placeholder={agent.status === 'running' ? 'send to stdin — Enter to submit' : 'session not running'}
        disabled={agent.status !== 'running'}
        className="mono"
        style={{
          flex: 1, background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--text)', fontSize: 12.5,
        }}
      />
    </div>
  )
}

function PaneLog({ agent }: { agent: Agent }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.log.length])

  const sm = STATUS_META[agent.status] || STATUS_META.idle

  return (
    <div ref={ref} className="mono" style={{
      flex: 1, overflowY: 'auto', padding: '13px 15px', fontSize: 12.5,
      lineHeight: 1.62, background: 'var(--bg)',
    }}>
      {agent.log.map((line, i) => (
        <div key={i} style={{
          color: LOG_COLORS[line.t] || 'var(--mut)',
          fontStyle: line.t === 'think' ? 'italic' : 'normal',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '1px 0',
        }}>
          {line.x}
        </div>
      ))}
      {agent.status === 'running' && (
        <div style={{ paddingTop: 3, color: sm.color }}>
          <span style={{ animation: 'cblink 1s step-end infinite' }}>▋</span>{' '}
          <span style={{ color: 'var(--faint)', fontSize: 11 }}>streaming</span>
        </div>
      )}
    </div>
  )
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

      <PaneLog agent={agent} />

      {agent.kind === 'real' && <PaneInput agent={agent} />}

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
  const { focusTab, toggleSplit } = useActions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const focused = s.focusedIds.slice(0, s.splitCount)
  const byId = new Map(s.agents.map(a => [a.id, a]))

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
        <button className="icon-btn" title="New agent session" onClick={() => setDialogOpen(true)} style={{ width: 30, height: 30, flexShrink: 0, color: '#9AA3B2' }}>
          <Icon paths={IC.plus} size={17} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 1, background: 'var(--line)' }}>
        {focused.map((id, i) => {
          const agent = byId.get(id) || s.agents[0]
          return <Pane key={`${id}-${i}`} agent={agent} index={i} active={i === s.activePane} showRing={s.splitCount > 1} />
        })}
      </div>
      {dialogOpen && <NewSessionDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
