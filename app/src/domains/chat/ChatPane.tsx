import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useActions, useConductorSelector } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import { providerFor, supportsThinking } from '../../llm/client'
import type { ThinkingEffort } from '../../llm/client'
import { isTauri, pickFiles, pickSavePath, readFileB64, writeTextFile } from '../../core/native'
import { listMentionFiles, matchFiles } from './mentions'
import { b64ToBytes, extractFileText } from '../../shared/filetext'
import type { CatalogSkill } from '../../core/skills'
import type { Agent, ChatAttachmentRecord, ChatMsg, ChatTurn } from '../../core/types'
import type { ChatAttachment } from './runner'
import { onAttachRequest } from './attach-bus'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { artifactSrcDoc, extractArtifact } from './artifacts'
import type { ChatArtifact } from './artifacts'

// Chat-mode session body: a Claude-Desktop-style conversation in a pane —
// the agent edits files, runs commands, loads skills, and calls MCP tools.
// The composer supports slash commands (skills + built-ins), a send queue
// while the agent is busy, and a stop button; messages have copy/retry.

const COPY_IC = ['M9 9h11v11H9z', 'M5 15H4V4h11v1']
const RETRY_IC = ['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']
const CLIP_IC = ['M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L16 6']
const EDIT_IC = ['M4 20h4l11-11-4-4L4 16v4z', 'M13 7l4 4']
const FORK_IC = ['M7 4v5a3 3 0 003 3h4', 'M17 4v5a3 3 0 01-3 3', 'M14 12v8']
const UP_IC = ['M7 11v9H4v-9h3', 'M7 11l4-7c1.5 0 2.5 1 2.5 2.5L13 11h5.3c1 0 1.8 1 1.5 2l-1.5 5.5c-.2.9-1 1.5-2 1.5H7']
const DOWN_IC = ['M17 13V4h3v9h-3', 'M17 13l-4 7c-1.5 0-2.5-1-2.5-2.5L11 13H5.7c-1 0-1.8-1-1.5-2l1.5-5.5c.2-.9 1-1.5 2-1.5H17']

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
  { name: 'compact', description: 'Compact the context — distill the conversation into a summary (transcript stays)' },
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
        onClick={() => setOverride(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
          fontSize: 11, color: 'var(--dim)', cursor: 'pointer', padding: '2px 6px', fontFamily: 'var(--font-sans)',
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
function ApprovalBubble({ m, busy, onDecide }: { m: ChatMsg; busy: boolean; onDecide: (decision: 'once' | 'always' | 'deny') => void }) {
  const pending = m.approval === 'pending'
  const verdict = m.approval === 'approved' ? '✓ allowed' : m.approval === 'denied' ? '✕ denied' : busy ? null : 'expired'
  return (
    <div style={{
      alignSelf: 'stretch', flexShrink: 0, margin: '0 4px', padding: '8px 12px', borderRadius: 10,
      background: 'rgba(245,196,81,.06)', border: '1px solid rgba(245,196,81,.3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>agent wants to run</span>
        {verdict && <span style={{ fontSize: 11, color: m.approval === 'approved' ? 'var(--green)' : 'var(--dim)', marginLeft: 'auto' }}>{verdict}</span>}
        {pending && busy && (
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button className="approve-btn" style={{ padding: '3px 12px', fontSize: 11 }} onClick={() => onDecide('once')}>Allow once</button>
            <button className="open-btn" style={{ padding: '3px 12px', fontSize: 11 }} onClick={() => onDecide('always')}>Always allow</button>
            <button className="open-btn" style={{ padding: '3px 12px', fontSize: 11 }} onClick={() => onDecide('deny')}>Deny</button>
          </span>
        )}
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--mut)', marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 90, overflowY: 'auto' }}>
        {m.text}
      </div>
    </div>
  )
}

function Bubble({ m, live, canRetry, onRetry, busy, onApprove, onArtifact, collapseTool, onEdit, onFork, onQuickReply, onRate }: { m: ChatMsg; live?: boolean; canRetry?: boolean; onRetry?: () => void; busy?: boolean; onApprove?: (msgId: string, decision: 'once' | 'always' | 'deny') => void; onArtifact?: (a: ChatArtifact) => void; collapseTool?: boolean; onEdit?: () => void; onFork?: () => void; onQuickReply?: (msgId: string, reply: string) => void; onRate?: (msgId: string, rating: 'up' | 'down', note?: string) => void }) {
  const [hover, setHover] = useState(false)
  const [copied, setCopied] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  if (m.role === 'thinking') return <ThinkingBubble m={m} live={!!live} />
  if (m.role === 'tool' && m.approval) {
    return <ApprovalBubble m={m} busy={!!busy} onDecide={ok => onApprove?.(m.id, ok)} />
  }
  if (m.role === 'tool' && collapseTool) return null
  if (m.role === 'tool') {
    return (
      <div title={m.text} style={{
        fontSize: 11, color: 'var(--dim)', padding: '2px 10px', alignSelf: 'stretch', minWidth: 0, flexShrink: 0,
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
  // ChatGPT-style: only the USER's messages are bubbles; the assistant's
  // replies flow full-width on the page background like a document
  if (user) {
    return (
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ display: 'flex', flexShrink: 0, alignItems: 'flex-end', gap: 4, justifyContent: 'flex-end', padding: '0 4px' }}
      >
        {hover && <div style={{ display: 'flex', gap: 2 }}>
          {onEdit && <HoverBtn title="Edit and replace from here" paths={EDIT_IC} onClick={onEdit} />}
          {onFork && <HoverBtn title="Edit in a new conversation fork" paths={FORK_IC} onClick={onFork} />}
          <HoverBtn title={copied ? 'Copied!' : 'Copy message'} paths={COPY_IC} onClick={copy} />
        </div>}
        <div style={{
          maxWidth: '78%', minWidth: 0, borderRadius: 16, padding: 'var(--bubble-pad)', fontSize: 'var(--chat-font)', lineHeight: 1.55,
          background: 'var(--panel2)',
          border: '1px solid var(--line2)',
          color: 'var(--text)', overflowWrap: 'break-word',
        }}>
          <Markdown text={m.text} />
        </div>
      </div>
    )
  }
  const artifact = live ? null : extractArtifact(m.text)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ flexShrink: 0, minWidth: 0, padding: '2px 4px', animation: 'cfade .18s ease-out both' }}
    >
      <div style={{ fontSize: 'var(--chat-font)', lineHeight: 1.6, color: 'var(--text)', overflowWrap: 'break-word' }}>
        <Markdown text={m.text} />
        {live && <span className="stream-caret" />}
      </div>
      {!live && !busy && !!m.suggestions?.length && onQuickReply && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {m.suggestions.map(reply => (
            <button
              key={reply}
              className="open-btn"
              title="Send this as your reply"
              onClick={() => onQuickReply(m.id, reply)}
              style={{ padding: '5px 13px', fontSize: 12 }}
            >
              {reply}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, minHeight: 22 }}>
        {artifact && onArtifact && (
          <button
            title="Render this output live in a sandboxed panel"
            onClick={() => onArtifact(artifact)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 10.5, fontWeight: 600,
              padding: '3px 10px', borderRadius: 7, background: hexToRgba(ACCENT, 0.08),
              border: `1px solid ${hexToRgba(ACCENT, 0.35)}`, color: 'var(--accent)',
            }}
          >
            <Icon paths={['M4 5h16v14H4z', 'M4 9h16']} size={11} stroke={1.8} />
            Open {artifact.kind.toUpperCase()} artifact
          </button>
        )}
        <div style={{ display: 'flex', gap: 2, opacity: (hover || !!m.feedback || noteOpen) && !live ? 1 : 0, transition: 'opacity .12s' }}>
          <HoverBtn title={copied ? 'Copied!' : 'Copy message'} paths={COPY_IC} onClick={copy} />
          {canRetry && onRetry && <HoverBtn title="Retry — regenerate from the last message" paths={RETRY_IC} onClick={onRetry} />}
          {onRate && (
            <>
              <button
                className="icon-btn"
                title={m.feedback === 'up' ? 'Remove rating' : 'Good reply — the agent learns from this'}
                onClick={() => { setNoteOpen(false); onRate(m.id, 'up') }}
                style={{ width: 22, height: 22, borderRadius: 6, color: m.feedback === 'up' ? 'var(--green)' : undefined }}
              >
                <Icon paths={UP_IC} size={12} stroke={1.8} />
              </button>
              <button
                className="icon-btn"
                title={m.feedback === 'down' ? 'Remove rating' : 'Bad reply — tell the agent what was wrong'}
                onClick={() => {
                  if (m.feedback === 'down') { setNoteOpen(false); onRate(m.id, 'down'); return }
                  setNoteOpen(v => !v)
                }}
                style={{ width: 22, height: 22, borderRadius: 6, color: m.feedback === 'down' ? 'var(--red, #e5697a)' : undefined }}
              >
                <Icon paths={DOWN_IC} size={12} stroke={1.8} />
              </button>
            </>
          )}
        </div>
      </div>
      {noteOpen && onRate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, maxWidth: 480 }}>
          <input
            autoFocus
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { onRate(m.id, 'down', noteText.trim() || undefined); setNoteOpen(false); setNoteText('') }
              if (e.key === 'Escape') { setNoteOpen(false); setNoteText('') }
            }}
            placeholder="what was wrong? (optional — becomes a lesson the agent applies)"
            style={{
              flex: 1, background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 7,
              color: 'var(--text)', fontSize: 11.5, padding: '5px 9px', outline: 'none',
            }}
          />
          <button
            className="open-btn"
            style={{ padding: '4px 12px', fontSize: 11, flexShrink: 0 }}
            onClick={() => { onRate(m.id, 'down', noteText.trim() || undefined); setNoteOpen(false); setNoteText('') }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  )
}

/** Live sandboxed preview of an assistant-produced document (HTML/SVG). */
function ArtifactPanel({ artifact, onClose }: { artifact: ChatArtifact; onClose: () => void }) {
  return (
    <div style={{ width: '46%', minWidth: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--line)', background: 'var(--panel)' }}>
      <div style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--line)' }}>
        <Icon paths={['M4 5h16v14H4z', 'M4 9h16']} size={13} stroke={1.7} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4 }}>ARTIFACT · {artifact.kind.toUpperCase()}</span>
        <span style={{ fontSize: 10, color: 'var(--dim)' }}>sandboxed · no network</span>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="Copy source"
          onClick={() => { void navigator.clipboard.writeText(artifact.source) }}
          style={{ width: 24, height: 24, borderRadius: 6 }}
        >
          <Icon paths={COPY_IC} size={11} stroke={1.8} />
        </button>
        <button className="icon-btn" title="Close artifact" onClick={onClose} style={{ width: 24, height: 24, borderRadius: 6 }}>
          <Icon paths={IC.close} size={11} stroke={2} />
        </button>
      </div>
      {/* same trust model as addon views: opaque origin, inline-only CSP */}
      <iframe
        title="chat artifact"
        sandbox="allow-scripts"
        srcDoc={artifactSrcDoc(artifact)}
        style={{ flex: 1, border: 'none', background: '#fff' }}
      />
    </div>
  )
}

/** @-mention autocomplete: files under the chat's working folder */
function FileMenu({ items, sel, onPick }: { items: string[]; sel: number; onPick: (path: string) => void }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: 6, zIndex: 30,
      background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 10,
      boxShadow: '0 -6px 24px rgba(0,0,0,.4)', overflow: 'hidden', maxHeight: 260, overflowY: 'auto',
    }}>
      {items.map((path, i) => {
        const cut = path.lastIndexOf('/')
        return (
          <button
            key={path}
            className="palette-item"
            onMouseDown={e => { e.preventDefault(); onPick(path) }}
            style={{
              width: '100%', display: 'flex', alignItems: 'baseline', gap: 8, border: 'none', textAlign: 'left',
              padding: '7px 12px', background: i === sel ? 'rgba(245,196,81,.1)' : 'transparent', cursor: 'pointer',
            }}
          >
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>{path.slice(cut + 1)}</span>
            {cut > 0 && (
              <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {path.slice(0, cut)}
              </span>
            )}
          </button>
        )
      })}
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
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>/{it.name}</span>
          {it.source && <span style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>[{it.source}]</span>}
          <span style={{ fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {it.description}
          </span>
        </button>
      ))}
    </div>
  )
}

export function ChatPane({ agent, active }: { agent: Agent; active: boolean }) {
  const { sendChatMessage, sendQuickReply, stopChat, retryChat, editAndResendChat, forkChatTurn, clearChat, compactChat, chatSkills, approveChatTool, setChatComposer, setChatConfig, rateChatReply } = useActions()
  const chatTypes = useConductorSelector(x => x.chatAgentTypes)
  const composer = agent.chatComposer ?? { draft: '', attachments: [], queue: [] }
  const draft = composer.draft
  const atts = composer.attachments
  const queue = composer.queue
  const setDraft = (value: string | ((current: string) => string)) => {
    const next = typeof value === 'function' ? value(draft) : value
    setChatComposer(agent.id, { draft: next })
  }
  const setAtts = (value: ChatAttachmentRecord[] | ((current: ChatAttachmentRecord[]) => ChatAttachmentRecord[])) => {
    const next = typeof value === 'function' ? value(atts) : value
    setChatComposer(agent.id, { attachments: next })
  }
  const setQueue = (value: typeof queue | ((current: typeof queue) => typeof queue)) => {
    const next = typeof value === 'function' ? value(queue) : value
    setChatComposer(agent.id, { queue: next })
  }
  const [loadingAtts, setLoadingAtts] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<ChatArtifact | null>(null)
  const [menuSel, setMenuSel] = useState(0)
  const [fileSel, setFileSel] = useState(0)
  // @-mention corpus: fetched lazily on the first '@' and cached per pane
  const [mentionFiles, setMentionFiles] = useState<string[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dequeuedRef = useRef(false)
  const log = agent.chatLog ?? []
  const busy = agent.status === 'running'
  const turns = new Map((agent.chatTurns ?? []).map(t => [t.id, t]))
  const reviseTurn = (turn: ChatTurn, mode: 'replace' | 'fork') => {
    if (busy) return
    setChatComposer(agent.id, { draft: turn.input.text, attachments: turn.input.attachments, mode, sourceTurnId: turn.id })
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

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

  // @file mention: the draft's trailing token is `@<query>` → file menu
  const atQuery = agent.cwd ? /(^|\s)@([\w./-]*)$/.exec(draft)?.[2] ?? null : null
  useEffect(() => {
    if (atQuery === null || mentionFiles !== null || !agent.cwd) return
    let live = true
    void listMentionFiles(agent.cwd).then(files => { if (live) setMentionFiles(files) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atQuery !== null, agent.cwd])
  const fileItems = useMemo(
    () => (atQuery === null ? [] : matchFiles(mentionFiles ?? [], atQuery)),
    [atQuery, mentionFiles],
  )
  const fileMenuOpen = !menuOpen && fileItems.length > 0

  // attach the picked file and strip the @token from the draft
  const pickMention = (rel: string) => {
    setDraft(d => d.replace(/@[\w./-]*$/, ''))
    void addPaths([`${agent.cwd!.replace(/\/+$/, '')}/${rel}`])
    inputRef.current?.focus()
  }

  useEffect(() => { setMenuSel(0) }, [slashQuery])
  useEffect(() => { setFileSel(0) }, [atQuery])

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
    setChatComposer(agent.id, { queue: rest })
    sendChatMessage(agent.id, next.text, next.attachments)
  }, [busy, queue, agent.id, sendChatMessage, setChatComposer])

  const flashNote = (t: string) => {
    setNote(t)
    window.setTimeout(() => setNote(null), 3000)
  }

  const addPaths = async (paths: string[]) => {
    const take = paths.slice(0, Math.max(0, 10 - atts.length))
    if (!take.length) return
    setLoadingAtts(n => n + take.length)
    const loaded: ChatAttachmentRecord[] = []
    for (const p of take) {
      try {
        const att = await loadAttachment(p)
        loaded.push({ name: att.name, kind: att.kind, text: att.text, mediaType: att.mediaType, path: att.path })
      } catch (e) {
        flashNote(`couldn't attach ${p.slice(p.lastIndexOf('/') + 1)}: ${e instanceof Error ? e.message : e}`)
      } finally {
        setLoadingAtts(n => n - 1)
      }
    }
    if (loaded.length) {
      const next = [...atts]
      for (const att of loaded) if (!next.some(a => a.path === att.path)) next.push(att)
      setAtts(next)
    }
  }

  // file-explorer attach requests (click a file's ＋ in the Files panel)
  useEffect(() => {
    return onAttachRequest(agent.id, path => void addPaths([path]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, atts.length])

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
    if (msg === '/compact') { void compactChat(agent.id).then(flashNote).catch(e => flashNote(`compact failed: ${e instanceof Error ? e.message : e}`)); return }
    if (msg === '/export') { void exportChat().catch(e => flashNote(`export failed: ${e instanceof Error ? e.message : e}`)); return }
    if (busy) {
      if (composer.sourceTurnId) { flashNote('wait for the current reply before revising history'); return }
      setQueue(q => [...q, { id: `queued-${Date.now()}-${q.length}`, at: Date.now(), text: msg, attachments: attachments ?? [] }])
      return
    }
    if (composer.sourceTurnId && composer.mode) {
      const sourceTurnId = composer.sourceTurnId
      setChatComposer(agent.id, { draft: '', attachments: [], mode: undefined, sourceTurnId: undefined })
      if (composer.mode === 'replace') editAndResendChat(agent.id, sourceTurnId, msg, attachments)
      else forkChatTurn(agent.id, sourceTurnId, msg, attachments)
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
    if (name === 'clear' || name === 'compact' || name === 'export') {
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
    if (fileMenuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setFileSel(s => (s + 1) % fileItems.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFileSel(s => (s - 1 + fileItems.length) % fileItems.length); return }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pickMention(fileItems[fileSel]); return }
      if (e.key === 'Escape') { e.preventDefault(); setDraft(d => d.replace(/@[\w./-]*$/, '')); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  // retry is offered on the last assistant message once the agent is idle
  const lastAssistantId = !busy ? [...log].reverse().find(m => m.role === 'assistant')?.id : undefined
  const hasUserMsg = log.some(m => m.role === 'user')

  // chat-bar brain picker: agent type (provider), model, thinking effort
  const chatType = chatTypes.find(t => t.id === agent.chatTypeId) ?? chatTypes.find(t => t.enabled) ?? chatTypes[0]
  const curModel = agent.chatModel || chatType?.model || ''
  const modelOptions = useMemo(() => {
    const base = chatType?.models?.length ? chatType.models : chatType ? providerFor(chatType.provider).models : []
    return [...new Set([curModel, chatType?.model ?? '', ...base].filter(Boolean))]
  }, [chatType, curModel])
  const canThink = chatType ? supportsThinking(chatType.provider, curModel) : false
  const pickerStyle = {
    background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 6, color: 'var(--mut)',
    fontSize: 10.5, padding: '2px 3px', maxWidth: 150, cursor: 'pointer', flexShrink: 0, fontFamily: 'var(--font-sans)',
  } as const

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', background: 'var(--bg2)' }}>
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', padding: '16px 36px' }}>
        {/* ChatGPT-style readable column: content centered at a comfortable width */}
        <div style={{ maxWidth: 860, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--chat-gap)' }}>
          {log.map((m, i) => {
            const turn = m.turnId ? turns.get(m.turnId) : undefined
            return (
              <Fragment key={m.id}>
                <Bubble
                  m={m}
                  live={busy && i === log.length - 1}
                  canRetry={m.id === lastAssistantId && hasUserMsg}
                  onRetry={() => retryChat(agent.id)}
                  busy={busy}
                  onApprove={(msgId, ok) => approveChatTool(agent.id, msgId, ok)}
                  onArtifact={setArtifact}
                  collapseTool={!!turn && turn.status !== 'running'}
                  onEdit={m.role === 'user' && turn && !busy ? () => reviseTurn(turn, 'replace') : undefined}
                  onFork={m.role === 'user' && turn && !busy ? () => reviseTurn(turn, 'fork') : undefined}
                  onQuickReply={(msgId, reply) => sendQuickReply(agent.id, msgId, reply)}
                  onRate={m.role === 'assistant' ? (msgId, rating, note) => rateChatReply(agent.id, msgId, rating, note) : undefined}
                />
              </Fragment>
            )
          })}
          {busy && log[log.length - 1]?.role !== 'assistant' && (
            <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 9, padding: '4px 4px' }}>
              <span className="typing-dots"><span /><span /><span /></span>
              <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>working…</span>
            </div>
          )}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '10px 36px', flexShrink: 0 }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {queue.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
            {queue.map((q, i) => (
              <span key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--mut)',
                background: 'var(--panel2)', border: '1px dashed var(--line2)', borderRadius: 7, padding: '3px 8px', maxWidth: 320,
              }}>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  queued: {q.text}{q.attachments.length ? ` (+${q.attachments.length} file${q.attachments.length > 1 ? 's' : ''})` : ''}
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
        {composer.sourceTurnId && composer.mode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, padding: '5px 8px', borderLeft: '2px solid var(--accent)', color: 'var(--mut)', fontSize: 11 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{composer.mode === 'replace' ? 'REPLACE FROM MESSAGE' : 'FORK FROM MESSAGE'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{turns.get(composer.sourceTurnId)?.input.text}</span>
            <button className="icon-btn" title="Cancel revision" onClick={() => setChatComposer(agent.id, { draft: '', attachments: [], mode: undefined, sourceTurnId: undefined })} style={{ width: 18, height: 18, marginLeft: 'auto', flexShrink: 0 }}>
              <Icon paths={IC.close} size={9} stroke={2} />
            </button>
          </div>
        )}
        {(atts.length > 0 || loadingAtts > 0) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
            {atts.map((a, i) => (
              <span key={a.path ?? i} title={a.path} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
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
            {loadingAtts > 0 && <span style={{ fontSize: 11, color: 'var(--dim)', padding: '3px 4px' }}>reading {loadingAtts} file{loadingAtts > 1 ? 's' : ''}…</span>}
          </div>
        )}
        <div style={{ position: 'relative', background: 'var(--panel2)', border: `1px solid ${dragOver ? 'var(--accent)' : 'var(--line2)'}`, borderRadius: 14, padding: '9px 12px' }}>
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
          {fileMenuOpen && <FileMenu items={fileItems} sel={fileSel} onPick={pickMention} />}
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? 'Working — new messages will queue…' : 'Message this agent — ⏎ to send, ⇧⏎ for a new line'}
            rows={2}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10.5, color: note ? 'var(--green)' : 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {note ?? `${agent.cwd || 'no working folder'} · / commands · @ files`}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', flexShrink: 0 }}>
              {chatTypes.length > 1 && (
                <select
                  title="Provider (chat agent type) — takes effect on the next message"
                  value={chatType?.id ?? ''}
                  disabled={busy}
                  onChange={e => setChatConfig(agent.id, { chatTypeId: e.target.value })}
                  style={pickerStyle}
                >
                  {chatTypes.filter(t => t.enabled || t.id === chatType?.id).map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
              {modelOptions.length > 0 && (
                <select
                  title="Model — takes effect on the next message"
                  value={curModel}
                  disabled={busy}
                  onChange={e => setChatConfig(agent.id, { chatModel: e.target.value })}
                  style={pickerStyle}
                >
                  {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              )}
              {canThink && (
                <select
                  title="Thinking effort — how much the model reasons before answering"
                  value={agent.chatEffort ?? ''}
                  disabled={busy}
                  onChange={e => setChatConfig(agent.id, { chatEffort: (e.target.value || null) as ThinkingEffort | null })}
                  style={pickerStyle}
                >
                  <option value="">think: off</option>
                  <option value="low">think: low</option>
                  <option value="medium">think: med</option>
                  <option value="high">think: high</option>
                </select>
              )}
            </div>
            <button
              className="icon-btn"
              title="Attach files (PDF, office docs, images, text…)"
              onClick={() => { void pickFiles().then(ps => addPaths(ps)) }}
              disabled={!isTauri}
              style={{ width: 26, height: 26, borderRadius: 7, marginLeft: 4, marginRight: 6, flexShrink: 0 }}
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
    </div>
    {artifact && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}
    </div>
  )
}
