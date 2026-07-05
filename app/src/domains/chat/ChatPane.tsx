import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useActions } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import { isTauri, pickFiles, pickSavePath, readFileB64, writeTextFile } from '../../core/native'
import { b64ToBytes, extractFileText } from '../../shared/filetext'
import type { CatalogSkill } from '../../core/skills'
import type { Agent, ChatMsg } from '../../core/types'
import type { ChatAttachment } from './runner'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'

// Chat-mode session body: a Claude-Desktop-style conversation in a pane —
// the agent edits files, runs commands, loads skills, and calls MCP tools.
// The composer supports slash commands (skills + built-ins), a send queue
// while the agent is busy, and a stop button; messages have copy/retry.

const COPY_IC = ['M9 9h11v11H9z', 'M5 15H4V4h11v1']
const RETRY_IC = ['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']
const CLIP_IC = ['M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L16 6']

/** Load one dropped/picked file into an attachment: images stay base64 for
 *  vision; documents go through best-effort text extraction; binaries attach
 *  as a pointer the agent can reach with its file tools. */
async function loadAttachment(path: string): Promise<ChatAttachment> {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const b64 = await readFileB64(path)
  const extracted = await extractFileText(name, b64ToBytes(b64))
  if (extracted.kind === 'image') return { name, kind: 'image', mediaType: extracted.mediaType, dataB64: b64, path }
  if (extracted.kind === 'binary') {
    return { name, kind: 'text', text: `(binary file — not inlined; the agent can access it at ${path})`, path }
  }
  return { name, kind: 'text', text: (extracted.text ?? '').slice(0, 60_000), path }
}

/** built-in slash commands shown alongside skills */
const BUILTINS = [
  { name: 'clear', description: 'Clear this conversation (transcript + context)' },
  { name: 'export', description: 'Export this conversation as markdown' },
]

/** Reasoning trace: always collapsible. Defaults open while the model is
 *  streaming its thoughts and collapsed once the answer starts; the user can
 *  override either way by clicking the header. */
function ThinkingBubble({ m, live }: { m: ChatMsg; live: boolean }) {
  // null = follow the default (open while live, collapsed when done)
  const [override, setOverride] = useState<boolean | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const open = override ?? live
  // keep the newest reasoning in view while it streams
  useEffect(() => {
    if (open && live && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [open, live, m.text])
  const chars = m.text.length > 400 ? ` · ${(m.text.length / 1000).toFixed(1)}k chars` : ''
  return (
    <div style={{ padding: '0 4px', minWidth: 0, flexShrink: 0 }}>
      <button
        className="mono"
        onClick={() => setOverride(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          fontSize: 10.5, color: 'var(--dim)', cursor: 'pointer', padding: '2px 6px',
        }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>▸</span>
        {live
          ? <><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} /> thinking…</>
          : <>thought{chars}</>}
      </button>
      {open && (
        <div ref={bodyRef} style={{
          fontSize: 11.5, color: 'var(--mut)', fontStyle: 'italic', whiteSpace: 'pre-wrap', lineHeight: 1.5,
          overflowWrap: 'anywhere', borderLeft: '2px solid var(--line2)',
          padding: '4px 10px', margin: '2px 0 2px 8px', maxHeight: 220, overflowY: 'auto',
        }}>
          {m.text}
        </div>
      )}
    </div>
  )
}

/** small icon button shown on message hover */
function HoverBtn({ title, paths, onClick }: { title: string; paths: string[]; onClick: () => void }) {
  return (
    <button className="icon-btn" title={title} onClick={onClick} style={{ width: 22, height: 22, borderRadius: 6 }}>
      <Icon paths={paths} size={12} stroke={1.8} />
    </button>
  )
}

/** Ask-mode approval prompt: Allow / Deny while the turn is paused on it. */
function ApprovalBubble({ m, busy, onDecide }: { m: ChatMsg; busy: boolean; onDecide: (ok: boolean) => void }) {
  const pending = m.approval === 'pending'
  const verdict = m.approval === 'approved' ? '✓ allowed' : m.approval === 'denied' ? '✕ denied' : busy ? null : 'expired'
  return (
    <div style={{
      alignSelf: 'stretch', flexShrink: 0, margin: '0 4px', padding: '8px 12px', borderRadius: 10,
      background: 'rgba(245,196,81,.06)', border: '1px solid rgba(245,196,81,.3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>agent wants to run</span>
        {verdict && <span className="mono" style={{ fontSize: 10.5, color: m.approval === 'approved' ? 'var(--green)' : 'var(--dim)', marginLeft: 'auto' }}>{verdict}</span>}
        {pending && busy && (
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button className="approve-btn" style={{ padding: '3px 14px', fontSize: 11.5 }} onClick={() => onDecide(true)}>Allow</button>
            <button className="open-btn" style={{ padding: '3px 14px', fontSize: 11.5 }} onClick={() => onDecide(false)}>Deny</button>
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--mut)', marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 90, overflowY: 'auto' }}>
        {m.text}
      </div>
    </div>
  )
}

function Bubble({ m, live, canRetry, onRetry, busy, onApprove }: { m: ChatMsg; live?: boolean; canRetry?: boolean; onRetry?: () => void; busy?: boolean; onApprove?: (msgId: string, ok: boolean) => void }) {
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  if (m.role === 'thinking') return <ThinkingBubble m={m} live={!!live} />
  if (m.role === 'tool' && m.approval) {
    return <ApprovalBubble m={m} busy={!!busy} onDecide={ok => onApprove?.(m.id, ok)} />
  }
  if (m.role === 'tool') {
    return (
      <div className="mono" title={m.text} style={{
        fontSize: 10.5, color: 'var(--dim)', padding: '2px 10px', alignSelf: 'stretch', minWidth: 0, flexShrink: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        ⚙ {m.text}
      </div>
    )
  }
  const user = m.role === 'user'
  const copy = () => {
    void navigator.clipboard.writeText(m.text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexShrink: 0, alignItems: 'flex-end', gap: 4, justifyContent: user ? 'flex-end' : 'flex-start', padding: '0 4px' }}
    >
      {user && hover && <HoverBtn title="Copy message" paths={COPY_IC} onClick={copy} />}
      <div style={{
        maxWidth: '88%', minWidth: 0, borderRadius: 11, padding: 'var(--bubble-pad)', fontSize: 'var(--chat-font)', lineHeight: 1.55,
        background: user ? hexToRgba(ACCENT, 0.13) : 'var(--panel2)',
        border: `1px solid ${user ? hexToRgba(ACCENT, 0.28) : 'var(--line2)'}`,
        color: 'var(--text)', overflowWrap: 'break-word',
      }}>
        <Markdown text={m.text} />
      </div>
      {!user && hover && (
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
          <HoverBtn title={copied ? 'Copied!' : 'Copy message'} paths={COPY_IC} onClick={copy} />
          {canRetry && onRetry && <HoverBtn title="Retry — regenerate from the last message" paths={RETRY_IC} onClick={onRetry} />}
        </div>
      )}
    </div>
  )
}

/** slash-command autocomplete: skills for this chat + built-ins */
function SlashMenu({ items, sel, onPick }: {
  items: { name: string; description: string; source?: string }[]
  sel: number
  onPick: (name: string) => void
}) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: 6, zIndex: 30,
      background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 10,
      boxShadow: '0 -6px 24px rgba(0,0,0,.4)', overflow: 'hidden', maxHeight: 260, overflowY: 'auto',
    }}>
      {items.map((it, i) => (
        <button
          key={`${it.source ?? 'builtin'}:${it.name}`}
          className="palette-item"
          onMouseDown={e => { e.preventDefault(); onPick(it.name) }}
          style={{
            width: '100%', display: 'flex', alignItems: 'baseline', gap: 8, border: 'none', textAlign: 'left',
            padding: '7px 12px', background: i === sel ? 'rgba(245,196,81,.1)' : 'transparent', cursor: 'pointer',
          }}
        >
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>/{it.name}</span>
          {it.source && <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>[{it.source}]</span>}
          <span style={{ fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {it.description}
          </span>
        </button>
      ))}
    </div>
  )
}

export function ChatPane({ agent, active }: { agent: Agent; active: boolean }) {
  const { sendChatMessage, stopChat, retryChat, clearChat, chatSkills, approveChatTool } = useActions()
  const [draft, setDraft] = useState('')
  const [queue, setQueue] = useState<{ text: string; atts?: ChatAttachment[] }[]>([])
  const [atts, setAtts] = useState<ChatAttachment[]>([])
  const [loadingAtts, setLoadingAtts] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [menuSel, setMenuSel] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dequeuedRef = useRef(false)
  const log = agent.chatLog ?? []
  const busy = agent.status === 'running'

  // slash menu: draft is a single line starting with "/" → filter skills + built-ins
  const slashQuery = /^\/([\w.-]*)$/.exec(draft.split('\n')[0]) && !draft.includes('\n') ? draft.slice(1) : null
  const menuItems = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const skills: CatalogSkill[] = chatSkills(agent.id)
    const all = [
      ...BUILTINS,
      ...skills.map(k => ({ name: k.name, description: k.description, source: k.source })),
    ]
    return all.filter(it => it.name.toLowerCase().includes(q)).slice(0, 12)
  }, [slashQuery, chatSkills, agent.id])
  const menuOpen = menuItems.length > 0

  useEffect(() => { setMenuSel(0) }, [slashQuery])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length, busy])

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  // auto-send the queue when the agent goes idle (one message per idle edge)
  useEffect(() => {
    if (busy) { dequeuedRef.current = false; return }
    if (!queue.length || dequeuedRef.current) return
    dequeuedRef.current = true
    const [next, ...rest] = queue
    setQueue(rest)
    sendChatMessage(agent.id, next.text, next.atts)
  }, [busy, queue, agent.id, sendChatMessage])

  const flashNote = (t: string) => {
    setNote(t)
    window.setTimeout(() => setNote(null), 3000)
  }

  const addPaths = async (paths: string[]) => {
    const take = paths.slice(0, Math.max(0, 10 - atts.length))
    if (!take.length) return
    setLoadingAtts(n => n + take.length)
    for (const p of take) {
      try {
        const att = await loadAttachment(p)
        setAtts(cur => (cur.some(a => a.path === att.path) ? cur : [...cur, att]))
      } catch (e) {
        flashNote(`couldn't attach ${p.slice(p.lastIndexOf('/') + 1)}: ${e instanceof Error ? e.message : e}`)
      } finally {
        setLoadingAtts(n => n - 1)
      }
    }
  }

  // native drag & drop: Tauri reports OS file drops with real paths
  useEffect(() => {
    if (!active || !isTauri) return
    let unlisten: (() => void) | null = null
    let alive = true
    void getCurrentWebview().onDragDropEvent(e => {
      if (e.payload.type === 'over') setDragOver(true)
      else if (e.payload.type === 'drop') { setDragOver(false); void addPaths(e.payload.paths) }
      else setDragOver(false)
    }).then(fn => { if (alive) unlisten = fn; else fn() })
    return () => { alive = false; unlisten?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, agent.id, atts.length])

  const exportChat = async () => {
    const md = log
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `**${m.role === 'user' ? 'You' : agent.name}** — ${new Date(m.at).toLocaleString()}\n\n${m.text}`)
      .join('\n\n---\n\n')
    const path = await pickSavePath(`${agent.name.replace(/[^\w.-]+/g, '-')}.md`, ['md'], 'Markdown')
    if (!path) return
    await writeTextFile(path, `# ${agent.name}\n\n${md}\n`)
    flashNote(`exported → ${path}`)
  }

  const submit = (text: string, attachments?: ChatAttachment[]) => {
    const msg = text.trim()
    if (!msg && !attachments?.length) return
    if (msg === '/clear') { clearChat(agent.id); setQueue([]); setAtts([]); return }
    if (msg === '/export') { void exportChat().catch(e => flashNote(`export failed: ${e instanceof Error ? e.message : e}`)); return }
    if (busy) {
      setQueue(q => [...q, { text: msg, atts: attachments }])
      return
    }
    sendChatMessage(agent.id, msg, attachments)
  }

  const send = () => {
    if (loadingAtts > 0) { flashNote('still reading attachments…'); return }
    if (!draft.trim() && !atts.length) return
    submit(draft, atts.length ? atts : undefined)
    setDraft('')
    setAtts([])
  }

  const pickSlash = (name: string) => {
    if (name === 'clear' || name === 'export') {
      submit(`/${name}`)
      setDraft('')
      return
    }
    setDraft(`/${name} `)
    inputRef.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenuSel(s => (s + 1) % menuItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenuSel(s => (s - 1 + menuItems.length) % menuItems.length); return }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pickSlash(menuItems[menuSel].name); return }
      if (e.key === 'Escape') { e.preventDefault(); setDraft(''); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  // retry is offered on the last assistant message once the agent is idle
  const lastAssistantId = !busy ? [...log].reverse().find(m => m.role === 'assistant')?.id : undefined
  const hasUserMsg = log.some(m => m.role === 'user')

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg2)' }}>
      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 'var(--chat-gap)' }}>
        {log.map((m, i) => (
          <Bubble
            key={m.id}
            m={m}
            live={busy && i === log.length - 1}
            canRetry={m.id === lastAssistantId && hasUserMsg}
            onRetry={() => retryChat(agent.id)}
            busy={busy}
            onApprove={(msgId, ok) => approveChatTool(agent.id, msgId, ok)}
          />
        ))}
        {busy && (
          <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 8, padding: '2px 10px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>working…</span>
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '10px 12px', flexShrink: 0 }}>
        {queue.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
            {queue.map((q, i) => (
              <span key={i} className="mono" style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--mut)',
                background: 'var(--panel2)', border: '1px dashed var(--line2)', borderRadius: 7, padding: '3px 8px', maxWidth: 320,
              }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  queued: {q.text}{q.atts?.length ? ` (+${q.atts.length} file${q.atts.length > 1 ? 's' : ''})` : ''}
                </span>
                <button
                  className="icon-btn"
                  title="Remove from queue"
                  onClick={() => setQueue(cur => cur.filter((_, j) => j !== i))}
                  style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0 }}
                >
                  <Icon paths={IC.close} size={8} stroke={2} />
                </button>
              </span>
            ))}
          </div>
        )}
        {(atts.length > 0 || loadingAtts > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
            {atts.map((a, i) => (
              <span key={a.path ?? i} className="mono" title={a.path} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5,
                color: a.kind === 'image' ? 'var(--accent)' : 'var(--mut)',
                background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 7, padding: '3px 8px', maxWidth: 260,
              }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.kind === 'image' ? '🖼' : '📎'} {a.name}
                </span>
                <button
                  className="icon-btn"
                  title="Remove attachment"
                  onClick={() => setAtts(cur => cur.filter((_, j) => j !== i))}
                  style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0 }}
                >
                  <Icon paths={IC.close} size={8} stroke={2} />
                </button>
              </span>
            ))}
            {loadingAtts > 0 && <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', padding: '3px 4px' }}>reading {loadingAtts} file{loadingAtts > 1 ? 's' : ''}…</span>}
          </div>
        )}
        <div style={{ position: 'relative', background: 'var(--panel2)', border: `1px solid ${dragOver ? 'var(--accent)' : 'var(--line2)'}`, borderRadius: 11, padding: '8px 11px' }}>
          {dragOver && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(245,196,81,.08)', border: '1px dashed var(--accent)', borderRadius: 11,
              fontSize: 12, color: 'var(--accent)', pointerEvents: 'none',
            }}>
              drop files to attach
            </div>
          )}
          {menuOpen && <SlashMenu items={menuItems} sel={menuSel} onPick={pickSlash} />}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? 'agent is working — messages queue until it finishes…' : 'Message this agent — “/” for skills & commands. It can edit files, run commands, call MCP tools…'}
            rows={2}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 10, color: note ? 'var(--green)' : 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {note ?? `${agent.cwd || 'no working folder'} · ↩ send · / commands · drop files to attach`}
            </span>
            <button
              className="icon-btn"
              title="Attach files (PDF, office docs, images, text…)"
              onClick={() => { void pickFiles().then(ps => addPaths(ps)) }}
              disabled={!isTauri}
              style={{ width: 26, height: 26, borderRadius: 7, marginLeft: 'auto', marginRight: 6, flexShrink: 0 }}
            >
              <Icon paths={CLIP_IC} size={14} stroke={1.7} />
            </button>
            {busy ? (
              <button
                className="send-btn"
                title="Stop the current reply"
                onClick={() => stopChat(agent.id)}
                style={{ width: 28, height: 28, flexShrink: 0 }}
              >
                <Icon paths={['M8 8h8v8H8z']} size={13} stroke={2} />
              </button>
            ) : (
              <button className="send-btn" onClick={send} style={{ width: 28, height: 28, flexShrink: 0, opacity: draft.trim() ? 1 : 0.45 }}>
                <Icon paths={IC.send} size={14} stroke={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
