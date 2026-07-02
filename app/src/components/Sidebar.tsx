import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT, hexToRgba } from '../data'
import type { Message } from '../types'
import { IC, Icon, MasterMark } from './ui'

function RouteCard({ msg }: { msg: Message }) {
  return (
    <>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: '#C7CCD6', marginBottom: 9 }}>{msg.text}</div>
      <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' }}>
        <div className="mono" style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px',
          borderBottom: '1px solid var(--line)', fontSize: 10.5, fontWeight: 600,
          letterSpacing: 0.4, color: 'var(--accent)',
        }}>
          <Icon paths={IC.route} size={13} stroke={1.8} />
          AUTO-ROUTED
        </div>
        {msg.routes?.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{r.name}</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 1 }}>{r.repo}</div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4,
              color: r.color, background: hexToRgba(r.color, 0.16), borderRadius: 6, padding: '3px 7px',
            }}>
              {r.action}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

function EscalateCard({ msg }: { msg: Message }) {
  const { approve, deny, answerPrompt } = useActions()
  const esc = msg.esc!
  const decisionColor = esc.decision === 'denied' ? 'var(--red-soft)' : 'var(--green)'
  const hasOptions = Boolean(esc.options?.length)
  return (
    <div style={{
      background: 'rgba(255,176,32,.06)', border: '1px solid rgba(255,176,32,.35)',
      borderLeft: '3px solid var(--amber)', borderRadius: 10, padding: 12,
      animation: esc.resolved ? 'none' : 'cattn 2.6s ease-in-out infinite',
    }}>
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--amber)', marginBottom: 8 }}>
        <Icon paths={IC.warn} size={14} stroke={1.8} />
        NEEDS YOUR DECISION
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: esc.color }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{esc.name}</span>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{esc.repo}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#C7CCD6', marginBottom: 11 }}>{esc.reason}</div>
      {!esc.resolved ? (
        hasOptions ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {esc.options!.map(o => (
              <button
                key={o.num}
                className="option-btn"
                onClick={() => answerPrompt(msg.escFor!, o.num)}
              >
                <span className="mono" style={{ color: 'var(--accent)', flexShrink: 0 }}>{o.num}.</span>
                <span style={{ flex: 1, textAlign: 'left' }}>{o.label}</span>
              </button>
            ))}
            <button className="deny-btn" style={{ padding: 7, fontSize: 12 }} onClick={() => deny(msg.escFor!)}>
              Dismiss (Esc)
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="approve-btn" style={{ flex: 1, padding: 8 }} onClick={() => approve(msg.escFor!)}>Approve &amp; resume</button>
            <button className="deny-btn" style={{ flex: 1, padding: 8 }} onClick={() => deny(msg.escFor!)}>Deny</button>
          </div>
        )
      ) : (
        <div style={{ fontSize: 12, fontWeight: 600, color: decisionColor, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: decisionColor }} />
          {esc.decision === 'denied' ? 'Denied · dismissed' : esc.choice ? `Chose ${esc.choice}` : 'Approved · agent resumed'}
        </div>
      )}
    </div>
  )
}

function BuildCard({ msg }: { msg: Message }) {
  const { setView } = useActions()
  const build = msg.build!
  return (
    <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 12, padding: 12 }}>
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--accent)', marginBottom: 8 }}>
        <Icon paths={IC.bolt} size={14} stroke={1.7} />
        BUILT A {build.kind === 'tool' ? 'TOOL' : 'SCHEDULE'}
      </div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{build.title}</div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3, lineHeight: 1.45 }}>{build.detail}</div>
      <button className="view-btn" style={{ marginTop: 10 }} onClick={() => setView(build.view)}>View →</button>
    </div>
  )
}

const BUILD_STEPS = ['Planning layout', 'Generating components', 'Wiring live data', 'Mounting panel']

function BuildUICard({ msg }: { msg: Message }) {
  const b = msg.buildUI!
  return (
    <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 12, padding: 13 }}>
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--accent)', marginBottom: 11 }}>
        <Icon paths={IC.bolt} size={14} stroke={1.7} />
        SELF-BUILDING · {b.title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {BUILD_STEPS.map((label, i) => {
          const done = b.stage > i + 1 || b.done
          const active = b.stage === i + 1 && !b.done
          const color = done ? 'var(--green)' : active ? ACCENT : '#3a4150'
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: '#C7CCD6' }}>
              <span style={{
                width: 15, height: 15, borderRadius: '50%', border: `1.5px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color,
              }}>
                {done && (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 6" />
                  </svg>
                )}
                {active && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, animation: 'cpulse 1s ease-in-out infinite' }} />}
              </span>
              {label}
            </div>
          )
        })}
      </div>
      {b.done && (
        <div style={{ marginTop: 12, background: '#0A0B0F', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
          <div className="mono" style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--mut)', marginBottom: 9 }}>{b.title}</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 56 }}>
            {b.bars.map((v, i) => (
              <div key={i} style={{ flex: 1, height: Math.round(8 + v * 46), background: 'var(--accent)', borderRadius: '3px 3px 0 0', opacity: 0.85 }} />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />Mounted · live in your workspace
          </div>
        </div>
      )}
    </div>
  )
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  const steps = content.split('\n').filter(Boolean).length
  return (
    <div style={{ marginBottom: 7 }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="mono"
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none',
          color: 'var(--dim)', fontSize: 10.5, padding: '2px 0',
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
        thinking · {steps} step{steps === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="mono" style={{
          marginTop: 5, background: 'var(--bg)', border: '1px solid #1a1e26', borderRadius: 9,
          padding: '9px 11px', fontSize: 11, lineHeight: 1.55, color: 'var(--dim)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto',
        }}>
          {content}
        </div>
      )}
    </div>
  )
}

function MessageRow({ msg }: { msg: Message }) {
  if (msg.role === 'you') {
    return (
      <div style={{
        alignSelf: 'flex-end', maxWidth: '90%', background: 'var(--panel3)', border: '1px solid var(--line2)',
        borderRadius: '12px 12px 3px 12px', padding: '9px 12px', fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
      }}>
        {msg.text}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <div style={{ marginTop: 1 }}>
        <MasterMark size={24} glow={false} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.kind === 'text' && (
          <div style={{ paddingTop: 3 }}>
            {msg.thinking && <ThinkingBlock content={msg.thinking} />}
            <div style={{ fontSize: 13, lineHeight: 1.55, color: '#C7CCD6' }}>{msg.text}</div>
          </div>
        )}
        {msg.kind === 'route' && <RouteCard msg={msg} />}
        {msg.kind === 'escalate' && <EscalateCard msg={msg} />}
        {msg.kind === 'build' && <BuildCard msg={msg} />}
        {msg.kind === 'buildui' && <BuildUICard msg={msg} />}
      </div>
    </div>
  )
}

export function Sidebar() {
  const s = useConductor()
  const { setComposer, send } = useActions()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.messages])

  const runningCount = s.agents.filter(a => a.status === 'running').length

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{
      width: 392, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, width: 2,
        background: 'linear-gradient(180deg, rgba(245,196,81,.5), transparent 60%)',
      }} />

      <div style={{ padding: '15px 17px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 11 }}>
        <MasterMark size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="grotesk" style={{ fontWeight: 600, fontSize: 15 }}>Master</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--panel)', background: 'var(--accent)', borderRadius: 5, padding: '1px 6px', fontWeight: 600 }}>ORCHESTRATOR</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: s.masterBusy ? 'var(--accent)' : 'var(--green)',
              animation: `cpulse ${s.masterBusy ? '0.9s' : '1.7s'} ease-in-out infinite`,
            }} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
              {s.masterBusy
                ? 'thinking…'
                : `${runningCount} sessions running${s.settings.masterEnabled && s.settings.apiKey ? ` · ${s.settings.masterModel}` : ' · brain off — configure in Settings'}`}
            </span>
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 15px', display: 'flex', flexDirection: 'column', gap: 15 }}>
        {s.messages.map(m => <MessageRow key={m.id} msg={m} />)}
      </div>

      <div style={{ borderTop: '1px solid var(--line)', padding: '12px 14px' }}>
        <div style={{ background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '10px 12px' }}>
          <textarea
            data-composer="1"
            value={s.composer}
            onChange={e => setComposer(e.target.value)}
            onKeyDown={onKey}
            placeholder="Tell Master what you need — it routes tasks, answers questions, and builds tools automatically…"
            rows={2}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              color: 'var(--text)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 13.5, lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
              ↩ send · Master picks the right action{isMac ? '' : ' · Ctrl+K to focus'}
            </span>
            <button className="send-btn" onClick={send}>
              <Icon paths={IC.send} size={17} stroke={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
