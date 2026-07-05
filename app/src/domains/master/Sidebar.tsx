import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { hasCreds } from '../../master'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import type { Message } from '../../core/types'
import { IC, Icon, MasterMark } from '../../components/ui'
import { Markdown } from '../../components/Markdown'

/** Render a Master routing decision with its target session context. */
function RouteCard({ msg }: { msg: Message }) {
  return (
    <>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text2)', marginBottom: 9 }}>{msg.text}</div>
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

/** Render an actionable session escalation and its response controls. */
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
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text2)', marginBottom: 11 }}>{esc.reason}</div>
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
          {esc.decision === 'denied' ? 'Denied · dismissed'
            : esc.decision === 'approved' ? (esc.choice ? `Chose ${esc.choice}` : 'Approved · agent resumed')
            : esc.choice ?? 'resolved'}
        </div>
      )}
    </div>
  )
}

/** Render the result of a Master-created tool or addon operation. */
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

/** Render a Master-created UI artifact message. */
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
          const color = done ? 'var(--green)' : active ? ACCENT : 'var(--line3)'
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text2)' }}>
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
        <div style={{ marginTop: 12, background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
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

/** Hide verbose Master reasoning and tool traces behind a disclosure control. */
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
          marginTop: 5, background: 'var(--bg)', border: '1px solid var(--line-soft)', borderRadius: 9,
          padding: '9px 11px', fontSize: 11, lineHeight: 1.55, color: 'var(--dim)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto',
        }}>
          {content}
        </div>
      )}
    </div>
  )
}

/** Dispatch a chat message to its specialized row renderer. */
function MessageRow({ msg }: { msg: Message }) {
  if (msg.role === 'you') {
    return (
      <div style={{
        alignSelf: 'flex-end', maxWidth: '90%', background: 'var(--panel3)', border: '1px solid var(--line2)',
        borderRadius: '12px 12px 3px 12px', padding: '9px 12px', fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
      }}>
        <Markdown text={msg.text ?? ''} />
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
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text2)' }}><Markdown text={msg.text ?? ''} /></div>
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

/** Render the resizable Master conversation, composer, and collapsed rail. */
export function Sidebar() {
  const s = useConductorSelector(x => ({
    agents: x.agents, composer: x.composer, masterBusy: x.masterBusy,
    messages: x.messages, pendingToolApprovals: x.pendingToolApprovals, settings: x.settings,
  }), shallowEqual)
  const { setComposer, send, updateSettings, resolveToolApproval } = useActions()
  const scrollRef = useRef<HTMLDivElement>(null)
  // stick-to-bottom scrolling: follow new messages only while the user is near
  // the bottom; when they scroll up to read, stop following and offer a jump
  const nearBottomRef = useRef(true)
  const [farFromBottom, setFarFromBottom] = useState(false)
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const width = Math.max(280, Math.min(640, s.settings.sidebarWidth ?? 392))

  // Track a window-level pointer drag and persist the clamped sidebar width.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    // Convert horizontal pointer movement into a clamped width update.
    const move = (ev: PointerEvent) => {
      updateSettings({ sidebarWidth: Math.max(280, Math.min(640, startW + ev.clientX - startX)) })
    }
    // Remove global drag listeners and restore the document cursor.
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottomRef.current = dist < 120
    setFarFromBottom(dist > 320)
  }

  // new messages: follow only while pinned near the bottom
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom()
  }, [s.messages])

  // first mount and every re-open from the collapsed rail: start at the bottom
  // (the container remounts, so the messages-dep effect alone never fires)
  useEffect(() => {
    if (!s.settings.sidebarHidden) {
      nearBottomRef.current = true
      setFarFromBottom(false)
      scrollToBottom()
    }
  }, [s.settings.sidebarHidden])

  const runningCount = s.agents.filter(a => a.status === 'running').length

  // Send on Enter while preserving Shift+Enter for multiline input.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  if (s.settings.sidebarHidden) {
    return (
      <button
        title="Show Master chat"
        onClick={() => updateSettings({ sidebarHidden: false })}
        style={{
          width: 30, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
          border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '12px 0', gap: 10, cursor: 'pointer',
        }}
      >
        <MasterMark size={20} glow={false} />
        {s.masterBusy && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
        )}
        <span style={{
          writingMode: 'vertical-rl', fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
          color: 'var(--dim)', marginTop: 2,
        }}>
          MASTER
        </span>
      </button>
    )
  }

  return (
    <div style={{
      width, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, width: 2,
        background: 'linear-gradient(180deg, rgba(245,196,81,.5), transparent 60%)',
      }} />
      <div
        onPointerDown={startResize}
        title="Drag to resize"
        style={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 5 }}
      />

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
              animation: s.masterBusy ? 'cpulse 0.9s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
              {s.masterBusy
                ? 'thinking…'
                : `${runningCount} session${runningCount === 1 ? '' : 's'} running${s.settings.masterEnabled && hasCreds(s.settings) ? ` · ${s.settings.masterModel}` : ' · brain off — configure in Settings'}`}
            </span>
          </div>
        </div>
        <button
          className="icon-btn"
          title="Hide Master chat"
          style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0 }}
          onClick={() => updateSettings({ sidebarHidden: true })}
        >
          <Icon paths={['M15 6l-6 6 6 6']} size={14} stroke={1.8} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '16px 15px', display: 'flex', flexDirection: 'column', gap: 15 }}>
          {s.messages.map(m => <MessageRow key={m.id} msg={m} />)}
        </div>
        {farFromBottom && (
          <button
            title="Jump to the latest message"
            onClick={() => { nearBottomRef.current = true; setFarFromBottom(false); scrollToBottom(true) }}
            style={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 6, padding: '5px 13px', borderRadius: 999,
              background: 'var(--panel3)', border: '1px solid var(--line2)', color: 'var(--text)',
              fontSize: 11.5, fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
            }}
          >
            <Icon paths={['M12 5v14', 'M6 13l6 6 6-6']} size={12} stroke={2} />
            Latest
          </button>
        )}
      </div>

      {s.pendingToolApprovals.length > 0 && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {s.pendingToolApprovals.map(pa => (
            <div key={pa.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(245,196,81,.07)', border: '1px solid rgba(245,196,81,.3)', borderRadius: 10, padding: '8px 10px' }}>
              <span style={{ flex: 1, fontSize: 12, lineHeight: 1.4 }}>
                Master wants to use <span className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{pa.toolId}</span> <span style={{ color: 'var(--dim)' }}>(Ask first)</span>
              </span>
              <button className="approve-btn" style={{ padding: '4px 12px', fontSize: 11.5 }} onClick={() => resolveToolApproval(pa.id, true)}>Approve once</button>
              <button className="deny-btn" style={{ padding: '4px 12px', fontSize: 11.5 }} onClick={() => resolveToolApproval(pa.id, false)}>Deny</button>
            </div>
          ))}
        </div>
      )}

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
              color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.5,
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
