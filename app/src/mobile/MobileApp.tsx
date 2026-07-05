// The phone companion app: pairing handshake, then tabs for Tasks / Chats /
// Sessions / Approvals. Pure polling client of the desktop's remote server —
// every action becomes a queued command the desktop applies through its own
// conductor actions.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { TerminalView } from './TerminalView'
import { FilesBrowser, GitReview } from './FilesGit'
import type { RemoteSnapshot } from '../domains/remote/snapshot'
import {
  deviceToken, fetchState, forgetPairing, pairingStatus, ping, requestPairing, sendCommand, streamUrl, urlToken,
} from './api'

const POLL_MS = 2000

type Pairing = 'checking' | 'bad-token' | 'unpaired' | 'waiting' | 'paired'
type Tab = 'tasks' | 'chats' | 'sessions' | 'approvals'
type Detail = { kind: 'task' | 'chat' | 'session'; id: string } | null

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

/** Real device + browser name from the user agent (e.g. "Pixel 8 · Chrome",
 *  "iPhone · Safari", "Mac · Firefox") — refined further via UA-Client-Hints
 *  where available. */
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
    // the Android UA carries the actual model: "(Linux; Android 14; Pixel 8)"
    const m = ua.match(/Android [^;)]+; ([^;)]+)/)
    device = m ? m[1].replace(/ Build\/.*/, '').trim() : 'Android'
  } else if (/Macintosh/.test(ua)) {
    // iPadOS Safari masquerades as a Mac but keeps its touchscreen
    device = navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac'
  } else if (/Windows/.test(ua)) device = 'Windows PC'
  else if (/Linux/.test(ua)) device = 'Linux'
  return `${device} · ${browser}`
}

interface UADataNavigator {
  userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string }> }
}

// ---------------------------------------------------------------- pairing

function PairScreen({ state, onPair }: { state: Pairing; onPair: (name: string) => void }) {
  const [name, setName] = useState(detectDeviceName())
  const edited = useRef(false)
  // Chromium exposes the precise model via UA-Client-Hints — refine the
  // suggestion unless the user already typed their own name
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
  if (state === 'checking') {
    return <div className="pairwrap"><div className="spinner" /></div>
  }
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
      <button className="btn primary" onClick={() => onPair(name.trim() || detectDeviceName())}>Request pairing</button>
    </div>
  )
}

// ---------------------------------------------------------------- shared

function Composer({ placeholder, onSend }: { placeholder: string; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState('')
  const send = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }
  return (
    <div className="composer">
      <textarea
        rows={1}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
      />
      <button disabled={!draft.trim()} onClick={send} aria-label="Send">↑</button>
    </div>
  )
}

/** Chat transcript with optimistic local echoes for messages sent from here. */
function Messages({ msgs, echoes, whoFor }: {
  msgs: { id: string; role: string; text: string }[]
  echoes: string[]
  whoFor?: (role: string) => string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const count = msgs.length + echoes.length
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [count])
  return (
    <div className="msgs">
      {msgs.filter(m => m.text).map(m => {
        const cls = m.role === 'user' ? 'user' : m.role === 'system' || m.role === 'tool' ? 'sys' : 'other'
        const who = whoFor?.(m.role)
        return (
          <div key={m.id} className={`bubble ${cls}`}>
            {who && <div className="who">{who}</div>}
            {cls === 'sys' ? `· ${m.text.slice(0, 200)} ·` : <Markdown text={m.text} />}
          </div>
        )
      })}
      {echoes.map((text, i) => (
        <div key={`echo-${i}`} className="bubble user" style={{ opacity: 0.55 }}>{text}</div>
      ))}
      <div ref={endRef} />
    </div>
  )
}

/** Track optimistic sends per target until the snapshot reflects them. */
function useEchoes(msgs: { role: string; text: string }[]) {
  const [echoes, setEchoes] = useState<string[]>([])
  useEffect(() => {
    setEchoes(cur => cur.filter(text => !msgs.some(m => m.role === 'user' && m.text === text)))
  }, [msgs])
  return { echoes, addEcho: (text: string) => setEchoes(cur => cur.concat([text])) }
}

// ---------------------------------------------------------------- screens

function TaskDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const t = snap.tasks.find(x => x.id === id)
  const { echoes, addEcho } = useEchoes(t?.chat ?? [])
  if (!t) return <div className="empty">This task is gone.</div>
  return (
    <>
      <div className="body">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="name" style={{ fontSize: 16, whiteSpace: 'normal' }}>{t.title}</span>
          <span className={`pill ${t.col}`}>{t.col}</span>
        </div>
        {t.description && <p style={{ color: 'var(--text2)', fontSize: 13.5, marginBottom: 8 }}>{t.description}</p>}
        {t.criteria.map((c, i) => <div key={i} className="crit"><span style={{ color: 'var(--green)' }}>✓</span>{c}</div>)}
        {t.watcherNote && <div className="warn">⌁ {t.watcherNote}</div>}
        {(t.col === 'backlog' || t.col === 'failed') && (
          <div className="btnrow">
            <button className="btn primary" onClick={() => void sendCommand({ kind: 'task_start', id: t.id })}>
              {t.col === 'failed' ? 'Retry task' : 'Start task'}
            </button>
          </div>
        )}
        <div className="section">WATCHER CHAT</div>
        <Messages msgs={t.chat} echoes={echoes} whoFor={r => (r === 'watcher' ? 'WATCHER' : null)} />
      </div>
      <Composer placeholder="Message the watcher…" onSend={text => { addEcho(text); void sendCommand({ kind: 'task_chat', id: t.id, text }) }} />
    </>
  )
}

function ChatDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const c = snap.chats.find(x => x.id === id)
  const { echoes, addEcho } = useEchoes(c?.msgs ?? [])
  if (!c) return <div className="empty">This chat is gone.</div>
  const pending = c.msgs.find(m => m.approval === 'pending')
  return (
    <>
      <div className="body">
        <Messages msgs={c.msgs} echoes={echoes} />
        {pending && (
          <div className="btnrow">
            <button className="btn ghost" onClick={() => void sendCommand({ kind: 'approve_chat', id: pending.id, agent_id: c.id, ok: false })}>Deny</button>
            <button className="btn primary" onClick={() => void sendCommand({ kind: 'approve_chat', id: pending.id, agent_id: c.id, ok: true })}>Allow</button>
          </div>
        )}
      </div>
      <Composer placeholder={`Message ${c.name}…`} onSend={text => { addEcho(text); void sendCommand({ kind: 'chat_send', id: c.id, text }) }} />
    </>
  )
}

function SessionDetail({ snap, id }: { snap: RemoteSnapshot; id: string }) {
  const [view, setView] = useState<'term' | 'files' | 'git'>('term')
  const s = snap.sessions.find(x => x.id === id)
  if (!s) return <div className="empty">This session is gone.</div>
  const live = s.status === 'running' || s.status === 'needs'
  return (
    <>
      <div className="body">
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="name" style={{ fontSize: 16 }}>{s.name}</span>
          <span className="spend">${s.cost.toFixed(2)}</span>
          <span className={`pill ${s.status}`}>{s.status}</span>
        </div>
        {s.task && <div className="meta">task · {s.task}</div>}
        {s.summary && <div className="meta" style={{ whiteSpace: 'normal' }}>{s.summary}</div>}
        {s.actionNeeded && <div className="warn">⚠ {s.actionNeeded}</div>}
        <div className="subtabs">
          {(['term', 'files', 'git'] as const).map(v => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'term' ? 'TERMINAL' : v === 'files' ? 'FILES' : 'CHANGES'}
            </button>
          ))}
        </div>
        {view === 'term' && (
          <>
            <TerminalView sessionId={s.id} data={s.term} cols={s.cols} />
            <div className="btnrow">
              {live
                ? <button className="btn danger" onClick={() => void sendCommand({ kind: 'session_stop', id: s.id })}>Stop session</button>
                : <button className="btn primary" onClick={() => void sendCommand({ kind: 'session_resume', id: s.id })}>Resume session</button>}
            </div>
          </>
        )}
        {view === 'files' && (s.cwd ? <FilesBrowser root={s.cwd} /> : <div className="empty">No working folder.</div>)}
        {view === 'git' && (s.cwd ? <GitReview root={s.cwd} /> : <div className="empty">No working folder.</div>)}
      </div>
      {live && view === 'term' && <Composer placeholder="Type into the terminal…" onSend={text => void sendCommand({ kind: 'session_input', id: s.id, text })} />}
    </>
  )
}

const COL_ORDER = ['progress', 'review', 'backlog', 'done', 'failed']

function Lists({ tab, snap, open, selected }: { tab: Tab; snap: RemoteSnapshot; open: (d: Detail) => void; selected?: string }) {
  const cardCls = (id: string) => `card${selected === id ? ' sel' : ''}`
  if (tab === 'tasks') {
    const tasks = [...snap.tasks].sort((a, b) => COL_ORDER.indexOf(a.col) - COL_ORDER.indexOf(b.col))
    return (
      <div className="body">
        {tasks.length === 0 && <div className="empty">No tasks on the board.</div>}
        {tasks.map(t => (
          <button key={t.id} className={cardCls(t.id)} onClick={() => open({ kind: 'task', id: t.id })}>
            <div className="row">
              <span className="name">{t.title}</span>
              {t.chat.length > 0 && <span className="spend">💬 {t.chat.length}</span>}
              <span className={`pill ${t.col}`}>{t.col}</span>
            </div>
            {t.watcherNote && <div className="meta">⌁ {t.watcherNote}</div>}
            {t.awaitingUser && <div className="warn">? waiting on you</div>}
          </button>
        ))}
      </div>
    )
  }
  if (tab === 'chats') {
    return (
      <div className="body">
        {snap.chats.length === 0 && <div className="empty">No chat conversations.</div>}
        {snap.chats.map(c => (
          <button key={c.id} className={cardCls(c.id)} onClick={() => open({ kind: 'chat', id: c.id })}>
            <div className="row">
              <span className="name">{c.name}</span>
              <span className="pill">{c.model}</span>
            </div>
            {c.msgs.length > 0 && <div className="meta">{c.msgs[c.msgs.length - 1].text.slice(0, 90)}</div>}
          </button>
        ))}
      </div>
    )
  }
  if (tab === 'sessions') {
    return (
      <div className="body">
        {snap.sessions.length === 0 && <div className="empty">No live sessions.</div>}
        {snap.sessions.map(s => (
          <button key={s.id} className={cardCls(s.id)} onClick={() => open({ kind: 'session', id: s.id })}>
            <div className="row">
              <span className="name">{s.name}</span>
              <span className="spend">${s.cost.toFixed(2)}</span>
              <span className={`pill ${s.status}`}>{s.status}</span>
            </div>
            {(s.task || s.summary) && <div className="meta">{s.task || s.summary}</div>}
            {s.actionNeeded && <div className="warn">⚠ {s.actionNeeded}</div>}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="body">
      {snap.approvals.length === 0 && <div className="empty">Nothing waiting on you. 🎉</div>}
      {snap.approvals.map(a => (
        <div key={`${a.kind}:${a.id}`} className="card" style={{ borderColor: 'rgba(255,176,32,.45)' }}>
          <div className="name" style={{ whiteSpace: 'normal' }}>{a.label}</div>
          <div className="mono" style={{ fontSize: 12, color: '#b7bdc9', margin: '6px 0 10px', maxHeight: 90, overflow: 'auto' }}>{a.detail}</div>
          <div className="btnrow" style={{ marginTop: 0 }}>
            <button
              className="btn ghost"
              onClick={() => void sendCommand({ kind: a.kind === 'master' ? 'approve_master' : 'approve_chat', id: a.id, agent_id: a.agentId, ok: false })}
            >
              Deny
            </button>
            <button
              className="btn primary"
              onClick={() => void sendCommand({ kind: a.kind === 'master' ? 'approve_master' : 'approve_chat', id: a.id, agent_id: a.agentId, ok: true })}
            >
              Allow
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- app

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'tasks', label: 'TASKS', glyph: '▦' },
  { id: 'chats', label: 'CHATS', glyph: '💬' },
  { id: 'sessions', label: 'SESSIONS', glyph: '❯_' },
  { id: 'approvals', label: 'APPROVALS', glyph: '✋' },
]

export function MobileApp() {
  const [pairing, setPairing] = useState<Pairing>('checking')
  const [snap, setSnap] = useState<RemoteSnapshot | null>(null)
  const [online, setOnline] = useState(true)
  const [tab, setTab] = useState<Tab>('tasks')
  const [detail, setDetail] = useState<Detail>(null)
  const wide = useWide()
  const pickTab = (t: Tab) => { setTab(t); setDetail(null) }

  // resolve the initial pairing state from the stored token
  useEffect(() => {
    void (async () => {
      if (!urlToken()) { setPairing('bad-token'); return }
      if (!(await ping())) { setPairing('bad-token'); return }
      setPairing(deviceToken() ? 'paired' : 'unpaired')
    })()
  }, [])

  const pair = useCallback((name: string) => {
    setPairing('waiting')
    void requestPairing(name).then(status => {
      if (status === 'already-paired' && deviceToken()) setPairing('paired')
    })
  }, [])

  // waiting → poll pairing status; paired → poll state (a 403 means revoked)
  useEffect(() => {
    if (pairing === 'waiting') {
      const iv = setInterval(() => {
        void pairingStatus().then(s => {
          if (s === 'paired') setPairing('paired')
          if (s === 'unknown') setPairing('unpaired') // denied on the desktop
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
            // a 403 is NOT automatically a lost pairing — the desktop may have
            // restarted with a rotated URL token. Drop the device token only
            // when the server explicitly no longer knows this device.
            void pairingStatus()
              .then(async st => {
                if (st !== 'unknown') return
                // the server may be mid-restart with an empty device map —
                // confirm before dropping the stored pairing
                await new Promise(r => setTimeout(r, 1500))
                const again = await pairingStatus().catch(() => 'pending' as const)
                if (again === 'unknown') { forgetPairing(); setPairing('unpaired'); setSnap(null) }
              })
              .catch(() => setPairing('bad-token')) // stale link — pairing kept
          })
      }
      // prefer SSE (the server pushes on every publish — chats/tasks stream
      // live); fall back to polling when the stream can't be established
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
        es.onerror = () => {
          es?.close()
          es = null
          startPolling()
        }
        tick() // immediate first paint while the stream connects
      } catch {
        startPolling()
      }
      return () => {
        es?.close()
        if (iv) clearInterval(iv)
      }
    }
  }, [pairing])

  if (pairing !== 'paired') {
    return (
      <div className="shell">
        <div className="topbar"><span className={`dot${pairing === 'bad-token' ? ' off' : ''}`} /><h1>YAAM Remote</h1></div>
        <PairScreen state={pairing} onPair={pair} />
      </div>
    )
  }

  const title = detail
    ? (detail.kind === 'task' ? snap?.tasks.find(t => t.id === detail.id)?.title
      : detail.kind === 'chat' ? snap?.chats.find(c => c.id === detail.id)?.name
      : snap?.sessions.find(s => s.id === detail.id)?.name) ?? '…'
    : snap?.workspace ?? 'YAAM'

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
      {t.label}
    </button>
  ))

  // wide viewport: desktop-app shell — icon rail, list column, detail pane
  if (wide) {
    return (
      <div className="shell">
        <div className="topbar">
          <span className="brand">YAAM REMOTE</span>
          <h1>{snap?.workspace ?? ''}</h1>
          <span className={`dot${online ? '' : ' off'}`} />
        </div>
        <div className="cols">
          <nav className="rail">{navButtons}</nav>
          <div className="listcol">
            {snap ? <Lists tab={tab} snap={snap} open={setDetail} selected={detail?.id} /> : <div className="pairwrap"><div className="spinner" /></div>}
          </div>
          <div className="detailcol">
            {detailView ?? <div className="placeholder">{snap ? (tab === 'approvals' ? 'Approvals are answered directly in the list' : `Select a ${tab.slice(0, -1)} on the left`) : ''}</div>}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="shell">
      <div className="topbar">
        {detail && <button className="back" onClick={() => setDetail(null)}>‹ Back</button>}
        <h1>{title}</h1>
        <span className={`dot${online ? '' : ' off'}`} />
      </div>
      {!snap ? (
        <div className="pairwrap"><div className="spinner" /></div>
      ) : (
        detailView ?? <Lists tab={tab} snap={snap} open={setDetail} />
      )}
      {!detail && <div className="tabs">{navButtons}</div>}
    </div>
  )
}
