// The phone companion — Conductor Mobile design: Space Grotesk headers, agent
// cards with tinted avatars and pulsing status pills, inbox-style approvals,
// free-flowing assistant chat, and a pill composer with file attachments
// pulled from the working folder via the rpc bridge.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { TerminalView } from './TerminalView'
import { FilesBrowser, GitReview } from './FilesGit'
import type { RemoteSnapshot } from '../domains/remote/snapshot'
import {
  deviceToken, ensureUrlToken, fetchState, forgetPairing, pairingStatus, ping, rememberUrlToken, requestPairing, sendCommand, streamUrl,
} from './api'

const POLL_MS = 2000
const ATT_CONTENT_CAP = 6000

type Pairing = 'checking' | 'bad-token' | 'unpaired' | 'waiting' | 'paired'
type Tab = 'master' | 'tasks' | 'chats' | 'sessions' | 'approvals'
type Detail = { kind: 'task' | 'chat' | 'session'; id: string } | null
interface Attachment { name: string; path: string; text: string }

/** Wide viewport → desktop-style icon rail + master-detail instead of tabs. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 880px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 880px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

/** Real device + browser name from the user agent (e.g. "Pixel 8 · Chrome"). */
function detectDeviceName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser'
  let device = 'Device'
  if (/iPhone/.test(ua)) device = 'iPhone'
  else if (/iPad/.test(ua)) device = 'iPad'
  else if (/Android/.test(ua)) {
    const m = ua.match(/Android [^;)]+; ([^;)]+)/)
    device = m ? m[1].replace(/ Build\/.*/, '').trim() : 'Android'
  } else if (/Macintosh/.test(ua)) {
    device = navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac'
  } else if (/Windows/.test(ua)) device = 'Windows PC'
  else if (/Linux/.test(ua)) device = 'Linux'
  return `${device} · ${browser}`
}

interface UADataNavigator {
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }> }
}

/** Deterministic tint for an avatar, from the design's agent palette. */
const AVATAR_COLORS = ['#E8A87C', '#34D399', '#B692F6', '#6C8EF5', '#F5C451', '#7FD1FF']
function tint(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}
const soft = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.14)`
}
const border = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.4)`
}
const initials = (name: string) => name.split(/[\s-_]+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '??'

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const c = tint(name)
  return (
    <div className="avatar" style={{ width: size, height: size, background: soft(c), border: `1px solid ${border(c)}`, color: c }}>
      {initials(name)}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = { running: 'Running', needs: 'Blocked', idle: 'Idle', error: 'Failed', progress: 'In progress', review: 'Review', backlog: 'Backlog', done: 'Done', failed: 'Failed' }
  return (
    <span className={`statuspill ${status}`}>
      <span className="sdot" />
      {label[status] ?? status}
    </span>
  )
}

function MobileMasterMark({ size = 28 }: { size?: number }) {
  const bar = (h: number) => (
    <span style={{ width: Math.max(3, Math.round(size * 0.11)), height: h, borderRadius: 999, background: '#1A1400', display: 'block' }} />
  )
  return (
    <span
      className="mastermark"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), gap: Math.max(2, Math.round(size * 0.08)) }}
    >
      {bar(Math.round(size * 0.22))}
      {bar(Math.round(size * 0.38))}
      {bar(Math.round(size * 0.55))}
    </span>
  )
}

// ---------------------------------------------------------------- pairing

function PairScreen({ state, onPair }: { state: Pairing; onPair: (name: string) => void }) {
  const [name, setName] = useState(detectDeviceName())
  const edited = useRef(false)
  useEffect(() => {
    const uad = (navigator as UADataNavigator).userAgentData
    uad?.getHighEntropyValues?.(['model'])
      .then(v => {
        if (v.model?.trim() && !edited.current) {
          setName(cur => `${v.model!.trim()} · ${cur.split(' · ')[1] ?? 'Browser'}`)
        }
      })
      .catch(() => {})
  }, [])
  if (state === 'checking') return <div className="pairwrap"><div className="spinner" /></div>
  if (state === 'bad-token') {
    return (
      <div className="pairwrap">
        <h2>Link out of date</h2>
        <p>The token in this link is no longer current (it may have rotated). Open the newest link from Settings → Remote Control on your desktop — this device's pairing is kept, no re-pairing needed.</p>
      </div>
    )
  }
  if (state === 'waiting') {
    return (
      <div className="pairwrap">
        <div className="spinner" />
        <h2>Waiting for approval…</h2>
        <p>Approve this device in the dialog on your desktop. Pairing completes here automatically.</p>
      </div>
    )
  }
  return (
    <div className="pairwrap">
      <h2>Pair this device</h2>
      <p>YAAM pairs devices explicitly: send a request, then approve it on your desktop. The minted device token is stored on both ends until you revoke it.</p>
      <input value={name} onChange={e => { edited.current = true; setName(e.target.value) }} placeholder="Device name" maxLength={40} />
      <button className="btn accent" onClick={() => onPair(name.trim() || detectDeviceName())}>Request pairing</button>
    </div>
  )
}

// ---------------------------------------------------------------- shared

function Composer({ placeholder, onSend, onAttach, children, lead }: {
  placeholder: string
  onSend: (text: string) => void
  onAttach?: () => void
  children?: React.ReactNode
  /** accessory rendered at the left of the input row (e.g. the terminal keys) */
  lead?: React.ReactNode
}) {
  const [draft, setDraft] = useState('')
  const send = () => {
    const text = draft.trim()
    if (!text && !children) return
    onSend(text)
    setDraft('')
  }
  return (
    <div className="composerwrap">
      {children && <div className="attbar">{children}</div>}
      <div className="composer">
        {lead}
        {onAttach && <button className="attachbtn" title="Attach a file from the working folder" onClick={onAttach}>＋</button>}
        <textarea
          rows={1}
          value={draft}
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          onFocus={e => {
            // iOS overlays the keyboard without resizing the layout — nudge
            // the composer back into the visible viewport
            const el = e.currentTarget
            setTimeout(() => el.scrollIntoView({ block: 'end' }), 250)
          }}
        />
        <button className="sendbtn" disabled={!draft.trim() && !children} onClick={send} aria-label="Send">↑</button>
      </div>
    </div>
  )
}

/** Chat transcript in the assistant design: user bubbles right, bot content
 *  free-flowing beside a small avatar, system lines centered mono. */
function Messages({ msgs, echoes, botWho, botAvatar }: {
  msgs: { id: string; role: string; text: string }[]
  echoes: string[]
  botWho?: string
  botAvatar?: React.ReactNode
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const count = msgs.length + echoes.length
  const lastLen = msgs.length ? msgs[msgs.length - 1].text.length : 0
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [count, lastLen])
  return (
    <div className="msgs">
      {msgs.filter(m => m.text).map(m => {
        if (m.role === 'user') return <div key={m.id} className="bubble-user">{m.text}</div>
        if (m.role === 'system' || m.role === 'tool') return <div key={m.id} className="sysline">· {m.text.slice(0, 200)} ·</div>
        return (
          <div key={m.id} className="botrow">
            <div className="botavatar" title={botWho}>{botAvatar ?? '⚡'}</div>
            <div className="botbody"><Markdown text={m.text} /></div>
          </div>
        )
      })}
      {echoes.map((text, i) => (
        <div key={`echo-${i}`} className="bubble-user" style={{ opacity: 0.55 }}>{text}</div>
      ))}
      <div ref={endRef} />
    </div>
  )
}

/** Track optimistic sends per target until the snapshot reflects them. */
function useEchoes(msgs: { role: string; text: string }[]) {
  const [echoes, setEchoes] = useState<string[]>([])
  useEffect(() => {
    setEchoes(cur => cur.filter(text => !msgs.some(m => m.role === 'user' && m.text.startsWith(text.slice(0, 80)))))
  }, [msgs])
  return { echoes, addEcho: (text: string) => setEchoes(cur => cur.concat([text])) }
}

/** Slide-in files sheet for browsing + attaching from a working folder. */
function FilesSheet({ root, onClose, onAttach }: { root: string; onClose: () => void; onAttach?: (a: Attachment) => void }) {
  return (
    <>
      <div className="sheetveil" onClick={onClose} />
      <div className="sheet">
        <div className="sheethead">
          <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>📁</span>
          <span className="stitle">{root.slice(root.lastIndexOf('/') + 1) || root}</span>
          <button className="sclose" onClick={onClose}>✕</button>
        </div>
        <div className="sheetbody">
          <FilesBrowser root={root} onAttach={onAttach && (a => { onAttach(a); onClose() })} />
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- screens

function TaskDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const t = snap.tasks.find(x => x.id === id)
  const { echoes, addEcho } = useEchoes(t?.chat ?? [])
  if (!t) return <div className="empty">This task is gone.</div>
  return (
    <>
      <div className="body">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <span className="name" style={{ fontSize: 17, whiteSpace: 'normal', fontFamily: 'var(--font-title)' }}>{t.title}</span>
          <StatusPill status={t.col} />
        </div>
        {t.description && <p style={{ color: 'var(--text2)', fontSize: 13.5, marginTop: 8, lineHeight: 1.55 }}>{t.description}</p>}
        {t.criteria.length > 0 && <div className="section">ACCEPTANCE CRITERIA</div>}
        {t.criteria.map((c, i) => <div key={i} className="crit"><span style={{ color: 'var(--green)' }}>✓</span>{c}</div>)}
        {t.watcherNote && <div className="warn">⌁ {t.watcherNote}</div>}
        {(t.col === 'backlog' || t.col === 'failed') && (
          <div className="btnrow">
            <button className="btn primary" onClick={() => void sendCommand({ kind: 'task_start', id: t.id })}>
              {t.col === 'failed' ? 'Retry task' : 'Start task'}
            </button>
          </div>
        )}
        <div className="section">WATCHER</div>
        <Messages msgs={t.chat.map(m => ({ ...m, role: m.role === 'watcher' ? 'assistant' : m.role }))} echoes={echoes} botWho="watcher" />
      </div>
      <Composer placeholder="Message the watcher…" onSend={text => { if (!text) return; addEcho(text); void sendCommand({ kind: 'task_chat', id: t.id, text }) }} />
    </>
  )
}

function ChatDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const c = snap.chats.find(x => x.id === id)
  const { echoes, addEcho } = useEchoes(c?.msgs ?? [])
  const [atts, setAtts] = useState<Attachment[]>([])
  const [filesOpen, setFilesOpen] = useState(false)
  const folder = c?.cwd ?? ''
  if (!c) return <div className="empty">This chat is gone.</div>
  const pending = c.msgs.find(m => m.approval === 'pending')
  const send = (text: string) => {
    if (!text && atts.length === 0) return
    const payload = atts.length
      ? `${text}\n\n${atts.map(a => `Attached file \`${a.path}\`:\n\`\`\`\n${a.text.slice(0, ATT_CONTENT_CAP)}\n\`\`\``).join('\n\n')}`
      : text
    addEcho(text || `(attached ${atts.map(a => a.name).join(', ')})`)
    setAtts([])
    void sendCommand({ kind: 'chat_send', id: c.id, text: payload })
  }
  return (
    <>
      <div className="body">
        {c.msgs.length === 0 && echoes.length === 0 && (
          <div style={{ textAlign: 'center', padding: '56px 20px 24px' }}>
            <div className="botavatar" style={{ width: 50, height: 50, borderRadius: 15, margin: '0 auto 16px', fontSize: 24 }}>⚡</div>
            <div style={{ fontFamily: 'var(--font-title)', fontSize: 20, fontWeight: 600 }}>How can I help?</div>
            {folder && <div style={{ fontSize: 13, color: 'var(--mut)', marginTop: 6 }}>Working in <span className="mono" style={{ color: 'var(--text2)' }}>{folder.slice(folder.lastIndexOf('/') + 1)}</span></div>}
          </div>
        )}
        <Messages msgs={c.msgs} echoes={echoes} botWho={c.name} />
        {c.busy && <div className="sysline">· thinking… ·</div>}
        {(() => {
          // quick-reply chips + 👍/👎 on the latest reply, mirroring desktop
          const last = [...c.msgs].reverse().find(m => m.role === 'assistant')
          if (!last || c.busy || echoes.length) return null
          return (
            <>
              {!!last.suggestions?.length && (
                <div className="btnrow" style={{ flexWrap: 'wrap' }}>
                  {last.suggestions.map(r => (
                    <button key={r} className="btn ghost" onClick={() => { addEcho(r); void sendCommand({ kind: 'chat_reply', id: last.id, agent_id: c.id, text: r }) }}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', padding: '2px 14px 6px' }}>
                <button
                  style={{ background: 'none', border: 'none', fontSize: 15, opacity: last.feedback === 'up' ? 1 : 0.4, padding: 4 }}
                  onClick={() => void sendCommand({ kind: 'chat_rate', id: last.id, agent_id: c.id, ok: true })}
                >
                  👍
                </button>
                <button
                  style={{ background: 'none', border: 'none', fontSize: 15, opacity: last.feedback === 'down' ? 1 : 0.4, padding: 4 }}
                  onClick={() => void sendCommand({ kind: 'chat_rate', id: last.id, agent_id: c.id, ok: false })}
                >
                  👎
                </button>
              </div>
            </>
          )
        })()}
        {pending && (
          <div className="btnrow">
            <button className="btn ghost" onClick={() => void sendCommand({ kind: 'approve_chat', id: pending.id, agent_id: c.id, ok: false })}>Deny</button>
            <button className="btn primary" onClick={() => void sendCommand({ kind: 'approve_chat', id: pending.id, agent_id: c.id, ok: true })}>Allow</button>
          </div>
        )}
      </div>
      <Composer
        placeholder="Ask anything"
        onSend={send}
        onAttach={folder ? () => setFilesOpen(true) : undefined}
      >
        {atts.length > 0 && atts.map((a, i) => (
          <div key={i} className="attchip">
            <span className="aicon">📄</span>
            <span className="aname">{a.name}</span>
            <button className="arm" onClick={() => setAtts(cur => cur.filter((_, idx) => idx !== i))}>✕</button>
          </div>
        ))}
      </Composer>
      {filesOpen && folder && (
        <FilesSheet root={folder} onClose={() => setFilesOpen(false)} onAttach={a => setAtts(cur => cur.concat([a]))} />
      )}
    </>
  )
}

/** ⌨ toggle at the left of the composer; opens a horizontal popover of terminal
 *  keys (Esc, Tab, Shift+Tab, arrows, Enter) sent straight to the PTY. */
function SessionKeyStrip({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const key = (name: string) => { void sendCommand({ kind: 'session_key', id: sessionId, text: name }) }
  return (
    <div className="keywrap">
      <button
        className={`keytoggle${open ? ' on' : ''}`}
        title="Terminal keys"
        aria-label="Terminal keys"
        onClick={() => setOpen(v => !v)}
      >
        ⌨
      </button>
      {open && (
        <>
          <div className="keypop-veil" onClick={() => setOpen(false)} />
          <div className="keypop">
            <button onClick={() => key('esc')}>Esc</button>
            <button onClick={() => key('tab')}>Tab</button>
            <button className="wide" onClick={() => key('shift+tab')}>⇧Tab</button>
            <button onClick={() => key('left')}>←</button>
            <button onClick={() => key('up')}>↑</button>
            <button onClick={() => key('down')}>↓</button>
            <button onClick={() => key('right')}>→</button>
            <button className="wide" onClick={() => key('enter')}>Enter</button>
          </div>
        </>
      )}
    </div>
  )
}

function SessionDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const [view, setView] = useState<'term' | 'files' | 'git'>('term')
  const s = snap.sessions.find(x => x.id === id)
  if (!s) return <div className="empty">This session is gone.</div>
  const live = s.status === 'running' || s.status === 'needs'
  return (
    <>
      <div className="subtabs bar">
        {(['term', 'files', 'git'] as const).map(v => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v === 'term' ? 'TERMINAL' : v === 'files' ? 'FILES' : 'CHANGES'}
          </button>
        ))}
        {s.actionNeeded && view === 'term' && <span className="warn" style={{ margin: '0 0 0 auto', fontSize: 11, alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⚠ {s.actionNeeded}</span>}
      </div>
      {view === 'term' ? (
        <>
          <div className="termarea">
            <TerminalView sessionId={s.id} data={s.term} />
          </div>
          {live
            ? (
              <Composer placeholder="Message this agent…" onSend={text => { if (text) void sendCommand({ kind: 'session_input', id: s.id, text }) }} lead={<SessionKeyStrip sessionId={s.id} />} />
              )
            : (
              <div className="composerwrap">
                <button className="btn primary" style={{ width: '100%' }} onClick={() => void sendCommand({ kind: 'session_resume', id: s.id })}>Resume session</button>
              </div>
            )}
        </>
      ) : (
        <div className="body">
          {s.cwd
            ? (view === 'files' ? <FilesBrowser root={s.cwd} /> : <GitReview root={s.cwd} />)
            : <div className="empty">No working folder.</div>}
        </div>
      )}
    </>
  )
}

type MasterMsg = RemoteSnapshot['master']['msgs'][number]

function MasterThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const steps = text.split('\n').filter(Boolean).length
  return (
    <div className="mthink">
      <button onClick={() => setOpen(v => !v)}>
        <span style={{ transform: open ? 'rotate(90deg)' : undefined }}>▸</span>
        thinking · {steps} step{steps === 1 ? '' : 's'}
      </button>
      {open && <pre>{text}</pre>}
    </div>
  )
}

function MasterRouteCard({ msg }: { msg: MasterMsg }) {
  return (
    <div className="mcard">
      <div className="mcardlabel">AUTO-ROUTED</div>
      {msg.text && <div className="mcardtext"><Markdown text={msg.text} /></div>}
      {(msg.routes ?? []).map((r, i) => (
        <div className="mroute" key={`${r.name}-${i}`}>
          <span className="rdot" style={{ background: r.color }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rname">{r.name}</div>
            <div className="rrepo">{r.repo}</div>
          </div>
          <span className="raction" style={{ color: r.color }}>{r.action}</span>
        </div>
      ))}
    </div>
  )
}

function MasterEscalationCard({ msg }: { msg: MasterMsg }) {
  const esc = msg.esc
  if (!esc) return <div className="mcard"><Markdown text={msg.text} /></div>
  const sid = msg.escFor ?? ''
  const choose = (num: number) => sid && sendCommand({ kind: 'prompt_answer', id: sid, text: String(num) })
  const approve = () => sid && sendCommand({ kind: 'prompt_approve', id: sid })
  const deny = () => sid && sendCommand({ kind: 'prompt_deny', id: sid })
  return (
    <div className={`mcard warncard${esc.resolved ? '' : ' live'}`}>
      <div className="mcardlabel amber">NEEDS YOUR DECISION</div>
      <div className="magent">
        <span className="rdot" style={{ background: esc.color }} />
        <strong>{esc.name}</strong>
        <span>{esc.repo}</span>
      </div>
      <div className="mcardtext">{esc.reason}</div>
      {!esc.resolved ? (
        esc.options?.length ? (
          <div className="moptions">
            {esc.options.map(o => (
              <button key={o.num} onClick={() => void choose(o.num)}>
                <span>{o.num}.</span>
                {o.label}
              </button>
            ))}
            <button className="dangerline" onClick={() => void deny()}>Dismiss (Esc)</button>
          </div>
        ) : (
          <div className="btnrow">
            <button className="btn primary" onClick={() => void approve()} disabled={!sid}>Approve</button>
            <button className="btn ghost" onClick={() => void deny()} disabled={!sid}>Deny</button>
          </div>
        )
      ) : (
        <div className={`mdecision ${esc.decision === 'denied' ? 'bad' : ''}`}>
          {esc.decision === 'denied' ? 'Denied · dismissed'
            : esc.decision === 'approved' ? (esc.choice ? `Chose ${esc.choice}` : 'Approved · agent resumed')
            : esc.choice ?? 'resolved'}
        </div>
      )}
    </div>
  )
}

function MasterBuildCard({ msg }: { msg: MasterMsg }) {
  const b = msg.build
  if (!b) return <div className="mcard"><Markdown text={msg.text} /></div>
  return (
    <div className="mcard">
      <div className="mcardlabel">BUILT A {b.kind === 'tool' ? 'TOOL' : 'SCHEDULE'}</div>
      <div className="mbuildtitle">{b.title}</div>
      <div className="mcardtext">{b.detail}</div>
    </div>
  )
}

const BUILD_STEPS_MOBILE = ['Planning', 'Generating', 'Wiring data', 'Mounting']

function MasterBuildUICard({ msg }: { msg: MasterMsg }) {
  const b = msg.buildUI
  if (!b) return <div className="mcard"><Markdown text={msg.text || 'Built a view'} /></div>
  return (
    <div className="mcard">
      <div className="mcardlabel">SELF-BUILDING · {b.title}</div>
      <div className="msteps">
        {BUILD_STEPS_MOBILE.map((label, i) => {
          const done = b.stage > i + 1 || b.done
          const active = b.stage === i + 1 && !b.done
          return (
            <span key={label} className={done ? 'done' : active ? 'active' : ''}>
              <i />{label}
            </span>
          )
        })}
      </div>
      {b.done && (
        <div className="mbars">
          {b.bars.map((v, i) => <span key={i} style={{ height: `${Math.round(16 + v * 42)}px` }} />)}
        </div>
      )}
    </div>
  )
}

function MasterPayload({ msg }: { msg: MasterMsg }) {
  if (msg.kind === 'route') return <MasterRouteCard msg={msg} />
  if (msg.kind === 'escalate') return <MasterEscalationCard msg={msg} />
  if (msg.kind === 'build') return <MasterBuildCard msg={msg} />
  if (msg.kind === 'buildui') return <MasterBuildUICard msg={msg} />
  return (
    <div className="botbody">
      {msg.thinking && <MasterThinking text={msg.thinking} />}
      <Markdown text={msg.text} />
    </div>
  )
}

function MasterMessages({ msgs, echoes }: { msgs: MasterMsg[]; echoes: string[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  const count = msgs.length + echoes.length
  const lastLen = msgs.length ? msgs[msgs.length - 1].text.length : 0
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [count, lastLen])
  return (
    <div className="msgs">
      {msgs.map(m => (
        m.role === 'user'
          ? <div key={m.id} className="bubble-user">{m.text}</div>
          : (
            <div key={m.id} className="botrow masterrow">
              <div className="botavatar masteravatar" title="Master"><MobileMasterMark size={24} /></div>
              <div className="masterbody"><MasterPayload msg={m} /></div>
            </div>
            )
      ))}
      {echoes.map((text, i) => (
        <div key={`echo-${i}`} className="bubble-user" style={{ opacity: 0.55 }}>{text}</div>
      ))}
      <div ref={endRef} />
    </div>
  )
}

function MasterApprovals({ snap }: { snap: RemoteSnapshot }) {
  const approvals = snap.approvals.filter(a => a.kind === 'master')
  if (!approvals.length) return null
  return (
    <div className="mdecisionbox">
      <div className="mcardlabel amber">MASTER TOOL APPROVALS</div>
      {approvals.map(a => (
        <div key={a.id} className="mtoolapproval">
          <div>
            <strong>{a.label}</strong>
            <span>{a.detail}</span>
          </div>
          <div className="btnrow">
            <button className="btn primary" onClick={() => void sendCommand({ kind: 'approve_master', id: a.id, ok: true })}>Approve</button>
            <button className="btn ghost" onClick={() => void sendCommand({ kind: 'approve_master', id: a.id, ok: false })}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Master orchestrator conversation — the mobile default view. Shares the same
 *  `s.messages` the desktop sidebar reads, so both stay in step. */
function MasterView({ snap }: { snap: RemoteSnapshot }) {
  const m = snap.master ?? { busy: false, brain: false, msgs: [] }
  const { echoes, addEcho } = useEchoes(m.msgs)
  const send = (text: string) => {
    if (!text) return
    addEcho(text)
    void sendCommand({ kind: 'master_send', id: 'master', text })
  }
  return (
    <>
      <div className="body">
        {m.msgs.length === 0 && echoes.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 20px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><MobileMasterMark size={50} /></div>
            <div style={{ fontFamily: 'var(--font-title)', fontSize: 20, fontWeight: 600 }}>Master</div>
            <div style={{ fontSize: 13, color: 'var(--mut)', marginTop: 6, lineHeight: 1.5 }}>
              {m.brain ? 'Route work, launch sessions, and ask about your fleet.' : 'No Master Brain configured — enable it in desktop Settings → Master Brain.'}
            </div>
          </div>
        ) : (
          !m.brain && <div className="warn" style={{ margin: '0 0 12px' }}>⚠ Master Brain is off — enable it in desktop Settings → Master Brain to get replies.</div>
        )}
        <MasterApprovals snap={snap} />
        <MasterMessages msgs={m.msgs} echoes={echoes} />
      </div>
      <Composer placeholder={m.brain ? 'Message Master…' : 'Message Master (brain off)'} onSend={send} />
    </>
  )
}

/** Workspace pill: shows the active workspace; with several workspaces it
 *  opens a dropdown that switches the WHOLE app (desktop follows — the fleet,
 *  board, and Master conversation are all per-workspace). */
function WorkspaceSwitcher({ snap, onSwitched }: { snap: RemoteSnapshot; onSwitched?: () => void }) {
  const [open, setOpen] = useState(false)
  const list = snap.workspaces ?? []
  const multi = list.length > 1
  if (!snap.workspace) return null
  return (
    <div className="wswrap">
      <button
        className={`wsbtn${open ? ' on' : ''}`}
        disabled={!multi}
        title={multi ? 'Switch workspace — the desktop switches too' : 'Workspace'}
        onClick={() => multi && setOpen(v => !v)}
      >
        <span className="wsglyph">▣</span>
        <span className="wsname">{snap.workspace}</span>
        {multi && <span className="wscaret">▾</span>}
      </button>
      {open && (
        <>
          <div className="keypop-veil" onClick={() => setOpen(false)} />
          <div className="wsmenu">
            {list.map(w => (
              <button
                key={w.id}
                className={w.id === snap.workspaceId ? 'on' : ''}
                title={w.windowed ? 'Open in its own desktop window — switching pulls it back into the main window' : undefined}
                onClick={() => {
                  setOpen(false)
                  if (w.id === snap.workspaceId) return
                  void sendCommand({ kind: 'workspace_switch', id: w.id })
                  onSwitched?.()
                }}
              >
                <span className="wsdot" style={{ opacity: w.id === snap.workspaceId ? 1 : 0 }}>●</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                {w.windowed && <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.65, flexShrink: 0 }}>⧉ window</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Top-bar stop control: first tap arms it, second tap within 3s confirms. */
function StopButton({ onStop }: { onStop: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const to = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(to)
  }, [armed])
  return (
    <button
      onClick={() => { if (armed) { onStop(); setArmed(false) } else setArmed(true) }}
      style={{
        flexShrink: 0, border: `1px solid ${armed ? 'var(--red)' : 'rgba(255,92,92,.4)'}`, borderRadius: 10,
        background: armed ? 'var(--red)' : 'rgba(255,92,92,.12)', color: armed ? '#fff' : 'var(--red-soft)',
        padding: '7px 12px', fontSize: 12, fontWeight: 600,
      }}
    >
      {armed ? 'Confirm stop' : '■ Stop'}
    </button>
  )
}

// ---------------------------------------------------------------- lists

const COL_ORDER = ['progress', 'review', 'backlog', 'done', 'failed']

function Lists({ tab, snap, open, selected, onNewChat }: {
  tab: Tab
  snap: RemoteSnapshot
  open: (d: Detail) => void
  selected?: string
  /** start a fresh conversation with a durable agent */
  onNewChat?: (durableAgentId: string) => void
}) {
  const cardCls = (id: string, attn = false) => `card${selected === id ? ' sel' : ''}${attn ? ' attn' : ''}`
  // design pickups: status filter chips on Agents, live search on Chat
  const [filter, setFilter] = useState<'all' | 'running' | 'needs' | 'idle'>('all')
  const [query, setQuery] = useState('')
  if (tab === 'tasks') {
    const tasks = [...snap.tasks].sort((a, b) => COL_ORDER.indexOf(a.col) - COL_ORDER.indexOf(b.col))
    return (
      <div className="body">
        {tasks.length === 0 && <div className="empty">No tasks on the board.</div>}
        {tasks.map(t => (
          <button key={t.id} className={cardCls(t.id, t.awaitingUser)} onClick={() => open({ kind: 'task', id: t.id })}>
            <div className="row">
              <span className="name">{t.title}</span>
              <StatusPill status={t.col} />
            </div>
            {t.watcherNote && <div className="lastline">⌁ {t.watcherNote}</div>}
            <div className="cardmeta">
              {t.chat.length > 0 && <span>💬 {t.chat.length}</span>}
              {t.criteria.length > 0 && <span>{t.criteria.length} criteria</span>}
              {t.awaitingUser && <span style={{ color: 'var(--amber)' }}>waiting on you</span>}
            </div>
          </button>
        ))}
      </div>
    )
  }
  if (tab === 'chats') {
    const q = query.trim().toLowerCase()
    const chatRow = (c: RemoteSnapshot['chats'][number]) => (
      <button key={c.id} className={cardCls(c.id)} onClick={() => open({ kind: 'chat', id: c.id })}>
        <div className="row">
          <Avatar name={c.name} size={34} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">
              {c.pinned && <span style={{ color: 'var(--accent)', fontSize: 10, marginRight: 5 }}>◆</span>}
              {c.name}
            </div>
            {c.busy
              ? <div className="meta" style={{ color: 'var(--accent)' }}>thinking…</div>
              : c.msgs.length > 0 && <div className="meta">{c.msgs[c.msgs.length - 1].text.slice(0, 80)}</div>}
          </div>
          <span className="pill">{c.model}</span>
        </div>
      </button>
    )
    if (q) {
      const chats = snap.chats.filter(c => (c.name + ' ' + (c.msgs[c.msgs.length - 1]?.text ?? '')).toLowerCase().includes(q))
      return (
        <div className="body">
          <div className="composer" style={{ borderRadius: 12, marginBottom: 12, padding: '2px 6px 2px 12px' }}>
            <textarea rows={1} value={query} placeholder="Search chats" onChange={e => setQuery(e.target.value.replace(/\n/g, ''))} style={{ maxHeight: 24 }} />
          </div>
          {chats.length === 0 && <div className="empty">No chats match.</div>}
          {chats.map(chatRow)}
        </div>
      )
    }
    // conversations grouped under their durable agents, mirroring the desktop
    // chat sidebar: pinned first, then most recent activity
    const byRecency = (a: RemoteSnapshot['chats'][number], b: RemoteSnapshot['chats'][number]) =>
      Number(b.pinned) - Number(a.pinned) || b.lastAt - a.lastAt
    const durables = snap.durables ?? []
    const groups = durables.map(d => ({ d, items: snap.chats.filter(c => c.durableAgentId === d.id).sort(byRecency) }))
    // snapshots from an older desktop have no durables — flat recency list
    const orphans = snap.chats.filter(c => !durables.some(d => d.id === c.durableAgentId)).sort(byRecency)
    return (
      <div className="body">
        <div className="composer" style={{ borderRadius: 12, marginBottom: 12, padding: '2px 6px 2px 12px' }}>
          <textarea rows={1} value={query} placeholder="Search chats" onChange={e => setQuery(e.target.value.replace(/\n/g, ''))} style={{ maxHeight: 24 }} />
        </div>
        {groups.length === 0 && orphans.length === 0 && <div className="empty">No chat conversations.</div>}
        {groups.map(({ d, items }) => (
          <div key={d.id}>
            <div className="section" style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 14 }}>
              <span style={{ width: 8, height: 8, borderRadius: 3, background: d.color, flexShrink: 0 }} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name.toUpperCase()}</span>
              {d.role && <span style={{ fontWeight: 400, color: 'var(--faint)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: 0 }}>{d.role}</span>}
              <button
                title={`New conversation with ${d.name}`}
                onClick={() => onNewChat?.(d.id)}
                style={{ marginLeft: 'auto', flexShrink: 0, width: 24, height: 24, borderRadius: 7, border: '1px solid var(--line)', background: 'var(--panel2)', color: 'var(--mut2)', fontSize: 14, lineHeight: 1 }}
              >
                ＋
              </button>
            </div>
            {items.length
              ? items.map(chatRow)
              : <div style={{ fontSize: 12, color: 'var(--faint)', padding: '2px 4px 6px' }}>no conversations yet</div>}
          </div>
        ))}
        {orphans.map(chatRow)}
      </div>
    )
  }
  if (tab === 'sessions') {
    const sessions = filter === 'all' ? snap.sessions
      : filter === 'idle' ? snap.sessions.filter(s => s.status !== 'running' && s.status !== 'needs')
      : snap.sessions.filter(s => s.status === filter)
    // triage grouping mirrors the desktop Runs rail: anything waiting on the
    // user first, live work second, everything else after
    const triageOf = (s: RemoteSnapshot['sessions'][number]) =>
      (s.status === 'needs' || s.attention || s.actionNeeded ? 'needs' : s.status === 'running' ? 'running' : 'idle')
    const triage = ([
      ['needs', 'NEEDS YOU'], ['running', 'RUNNING'], ['idle', 'IDLE'],
    ] as const).map(([id, label]) => ({ id, label, items: sessions.filter(s => triageOf(s) === id) }))
    return (
      <div className="body">
        <div className="chips" style={{ margin: '0 0 12px' }}>
          {([['all', 'All'], ['running', 'Running'], ['needs', 'Blocked'], ['idle', 'Idle']] as const).map(([id, label]) => (
            <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        {sessions.length === 0 && <div className="empty">No sessions{filter !== 'all' ? ' in this state' : ''}.</div>}
        {triage.filter(g => g.items.length > 0).map(g => (
          <div key={g.id}>
            <div className="section" style={{ marginTop: 14, ...(g.id === 'needs' ? { color: 'var(--amber)' } : {}) }}>
              {g.label} <span style={{ color: 'var(--faint)' }}>{g.items.length}</span>
            </div>
            {g.items.map(s => (
              <button key={s.id} className={cardCls(s.id, !!s.actionNeeded || s.attention)} onClick={() => open({ kind: 'session', id: s.id })}>
                <div className="row">
                  <Avatar name={s.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="name">{s.name}</div>
                    <div className="meta">{s.repo}{s.task ? ` · ${s.task}` : ''}</div>
                  </div>
                  <StatusPill status={s.status} />
                </div>
                {(s.summary || s.actionNeeded) && (
                  <div className="lastline" style={s.actionNeeded ? { color: 'var(--amber)' } : undefined}>
                    {s.actionNeeded ? `⚠ ${s.actionNeeded}` : s.summary}
                  </div>
                )}
                <div className="cardmeta">
                  <span>${s.cost.toFixed(2)}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--faint)' }}>{s.kind}</span>
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="body">
      {snap.approvals.length === 0 && <div className="empty">All clear — nothing waiting on you. 🎉</div>}
      {snap.approvals.map(a => (
        <div key={`${a.kind}:${a.id}`} className="inboxcard">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag">DECISION</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--mut2)' }}>{a.kind === 'master' ? 'Master' : 'Chat agent'}</span>
          </div>
          <div className="ititle">{a.label}</div>
          <div className="icmd">{a.detail}</div>
          <div className="btnrow">
            <button className="btn primary" onClick={() => void sendCommand({ kind: a.kind === 'master' ? 'approve_master' : 'approve_chat', id: a.id, agent_id: a.agentId, ok: true })}>Approve</button>
            <button className="btn ghost" onClick={() => void sendCommand({ kind: a.kind === 'master' ? 'approve_master' : 'approve_chat', id: a.id, agent_id: a.agentId, ok: false })}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- app

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'master', label: 'Master', glyph: '✦' },
  { id: 'tasks', label: 'Tasks', glyph: '▦' },
  { id: 'chats', label: 'Chat', glyph: '◍' },
  { id: 'sessions', label: 'Agents', glyph: '⌘' },
  { id: 'approvals', label: 'Inbox', glyph: '◔' },
]

const HEAD_SUB: Record<Tab, (s: RemoteSnapshot) => string> = {
  master: s => (s.master?.brain ? (s.master.busy ? 'thinking…' : 'orchestrator') : 'brain off'),
  tasks: s => `${s.tasks.length} on the board`,
  chats: s => `${s.chats.length} conversations`,
  sessions: s => `${s.sessions.length} sessions`,
  approvals: s => (s.approvals.length ? `${s.approvals.length} waiting on you` : 'all clear'),
}

export function MobileApp() {
  const [pairing, setPairing] = useState<Pairing>('checking')
  const [snap, setSnap] = useState<RemoteSnapshot | null>(null)
  const [online, setOnline] = useState(true)
  const [tab, setTab] = useState<Tab>('master')
  const [detail, setDetail] = useState<Detail>(null)
  const wide = useWide()

  // native back button: tab + detail live in history state, so the browser's
  // back gesture closes a detail (or steps back a tab switch) instead of
  // leaving the app
  useEffect(() => {
    history.replaceState({ tab: 'master', d: null }, '')
    const onPop = (e: PopStateEvent) => {
      const st = e.state as { tab?: Tab; d?: Detail } | null
      if (!st) return
      if (st.tab) setTab(st.tab)
      setDetail(st.d ?? null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const pickTab = (t: Tab) => {
    history.replaceState({ tab: t, d: null }, '')
    setTab(t)
    setDetail(null)
  }
  const openDetail = (d: Detail) => {
    if (d) history.pushState({ tab, d }, '')
    setDetail(d)
  }
  const closeDetail = () => history.back()
  // workspace switched: the open detail's entity lives in the OLD workspace —
  // drop back to the list without touching the history stack direction
  const leaveDetail = () => {
    history.replaceState({ tab, d: null }, '')
    setDetail(null)
  }

  // "new conversation" is fire-and-forget over the command queue — remember
  // the chats we already know for that agent and open the one that appears
  const pendingNew = useRef<{ agentId: string; known: Set<string> } | null>(null)
  const newChat = (durableAgentId: string) => {
    pendingNew.current = { agentId: durableAgentId, known: new Set(snap?.chats.map(c => c.id) ?? []) }
    void sendCommand({ kind: 'chat_new', id: durableAgentId })
  }
  useEffect(() => {
    const p = pendingNew.current
    if (!p || !snap) return
    const fresh = snap.chats.find(c => c.durableAgentId === p.agentId && !p.known.has(c.id))
    if (fresh) {
      pendingNew.current = null
      openDetail({ kind: 'chat', id: fresh.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  useEffect(() => {
    void (async () => {
      // no token on the URL → fall back to the last one that worked (a bare
      // bookmark reconnects instead of dead-ending on "link out of date")
      const token = ensureUrlToken()
      if (!token) { setPairing('bad-token'); return }
      if (!(await ping())) { setPairing('bad-token'); return }
      rememberUrlToken(token) // known-good — reuse it if the URL is ever blank
      setPairing(deviceToken() ? 'paired' : 'unpaired')
    })()
  }, [])

  const pair = useCallback((name: string) => {
    setPairing('waiting')
    void requestPairing(name).then(status => {
      if (status === 'already-paired' && deviceToken()) setPairing('paired')
    })
  }, [])

  useEffect(() => {
    if (pairing === 'waiting') {
      const iv = setInterval(() => {
        void pairingStatus().then(s => {
          if (s === 'paired') setPairing('paired')
          if (s === 'unknown') setPairing('unpaired')
        }).catch(() => {})
      }, 1500)
      return () => clearInterval(iv)
    }
    if (pairing === 'paired') {
      const tick = () => {
        fetchState()
          .then(s => { setSnap(s); setOnline(true) })
          .catch(e => {
            setOnline(false)
            if (!String(e).includes('403')) return
            void pairingStatus()
              .then(async st => {
                if (st !== 'unknown') return
                await new Promise(r => setTimeout(r, 1500))
                const again = await pairingStatus().catch(() => 'pending' as const)
                if (again === 'unknown') { forgetPairing(); setPairing('unpaired'); setSnap(null) }
              })
              .catch(() => setPairing('bad-token'))
          })
      }
      let es: EventSource | null = null
      let iv: ReturnType<typeof setInterval> | null = null
      const startPolling = () => {
        if (iv) return
        tick()
        iv = setInterval(tick, POLL_MS)
      }
      try {
        es = new EventSource(streamUrl())
        es.onmessage = e => {
          try { setSnap(JSON.parse(String(e.data)) as RemoteSnapshot); setOnline(true) } catch { /* partial frame */ }
        }
        es.onerror = () => { es?.close(); es = null; startPolling() }
        tick()
      } catch {
        startPolling()
      }
      return () => { es?.close(); if (iv) clearInterval(iv) }
    }
  }, [pairing])

  if (pairing !== 'paired') {
    return (
      <div className="shell">
        <div className="pagehead"><div className="titlerow"><h1>YAAM</h1><span className="sub">remote</span><span className={`dot${pairing === 'bad-token' ? ' off' : ''}`} /></div></div>
        <PairScreen state={pairing} onPair={pair} />
      </div>
    )
  }

  const detailTitle = detail
    ? (detail.kind === 'task' ? snap?.tasks.find(t => t.id === detail.id)?.title
      : detail.kind === 'chat' ? snap?.chats.find(c => c.id === detail.id)?.name
      : snap?.sessions.find(s => s.id === detail.id)?.name) ?? '…'
    : ''
  const detailSub = detail?.kind === 'session'
    ? snap?.sessions.find(s => s.id === detail.id)?.repo ?? ''
    : detail?.kind === 'chat'
      ? snap?.chats.find(c => c.id === detail.id)?.model ?? ''
      : ''
  const detailStatus = detail?.kind === 'session' ? snap?.sessions.find(s => s.id === detail.id)?.status : undefined

  const detailView = !snap ? null
    : detail?.kind === 'task' ? <TaskDetail snap={snap} id={detail.id} />
    : detail?.kind === 'chat' ? <ChatDetail snap={snap} id={detail.id} />
    : detail?.kind === 'session' ? <SessionDetail snap={snap} id={detail.id} />
    : null

  const navButtons = TABS.map(t => (
    <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => pickTab(t.id)}>
      <span className="glyph">
        {t.glyph}
        {t.id === 'approvals' && (snap?.approvals.length ?? 0) > 0 && <span className="badge">{snap!.approvals.length}</span>}
      </span>
      <span className="tlabel">{t.label}</span>
    </button>
  ))

  if (wide) {
    return (
      <div className="shell">
        <div className="topbar">
          <span className="brand">YAAM REMOTE</span>
          {snap && <WorkspaceSwitcher snap={snap} onSwitched={leaveDetail} />}
          <span style={{ flex: 1 }} />
          <span className={`dot${online ? '' : ' off'}`} />
        </div>
        <div className="cols">
          <nav className="rail">{navButtons}</nav>
          <div className="listcol">
            {!snap ? <div className="pairwrap"><div className="spinner" /></div>
              : tab === 'master' ? <div className="placeholder">Master orchestrates the whole fleet</div>
              : <Lists tab={tab} snap={snap} open={openDetail} selected={detail?.id} onNewChat={newChat} />}
          </div>
          <div className="detailcol">
            {snap && tab === 'master' ? <MasterView snap={snap} />
              : detailView ?? <div className="placeholder">{snap ? (tab === 'approvals' ? 'Decisions are answered directly in the list' : `Select a ${tab.slice(0, -1)} on the left`) : ''}</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="shell">
      {detail ? (
        <div className="detailhead">
          <button className="back" onClick={closeDetail}>‹</button>
          {detail.kind !== 'task' && <Avatar name={detailTitle} size={34} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="htitle">{detailTitle}</div>
            {detailSub && <div className="hsub">{detailSub}</div>}
          </div>
          {detail.kind === 'session' && (detailStatus === 'running' || detailStatus === 'needs')
            ? <StopButton onStop={() => void sendCommand({ kind: 'session_stop', id: detail.id })} />
            : detailStatus ? <StatusPill status={detailStatus} /> : null}
        </div>
      ) : (
        <div className="pagehead">
          <div className="titlerow">
            <h1>{TABS.find(t => t.id === tab)?.label}</h1>
            {snap && <span className="sub">{HEAD_SUB[tab](snap)}</span>}
            {snap && <span style={{ marginLeft: 'auto', alignSelf: 'center' }}><WorkspaceSwitcher snap={snap} onSwitched={leaveDetail} /></span>}
            <span className={`dot${online ? '' : ' off'}`} style={{ marginLeft: snap ? 8 : 'auto' }} />
          </div>
        </div>
      )}
      {!snap ? (
        <div className="pairwrap"><div className="spinner" /></div>
      ) : tab === 'master' && !detail ? (
        <MasterView snap={snap} />
      ) : (
        detailView ?? <Lists tab={tab} snap={snap} open={openDetail} onNewChat={newChat} />
      )}
      {!detail && <div className="tabs">{navButtons}</div>}
    </div>
  )
}
