import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions } from '../../store'
import { ACCENT, hexToRgba } from '../../data'
import type { Agent, ChatMsg } from '../../types'
import { IC, Icon } from '../ui'
import { Markdown } from '../Markdown'

// Chat-mode session body: a Claude-Desktop-style conversation in a pane —
// the agent edits files, runs commands, loads skills, and calls MCP tools.

function Bubble({ m }: { m: ChatMsg }) {
  if (m.role === 'tool') {
    return (
      <div className="mono" title={m.text} style={{
        fontSize: 10.5, color: 'var(--dim)', padding: '2px 10px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        ⚙ {m.text}
      </div>
    )
  }
  const user = m.role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: user ? 'flex-end' : 'flex-start', padding: '0 4px' }}>
      <div style={{
        maxWidth: '88%', minWidth: 0, borderRadius: 11, padding: '8px 12px', fontSize: 13, lineHeight: 1.55,
        background: user ? hexToRgba(ACCENT, 0.13) : 'var(--panel2)',
        border: `1px solid ${user ? hexToRgba(ACCENT, 0.28) : 'var(--line2)'}`,
        color: 'var(--text)', overflowWrap: 'break-word',
      }}>
        <Markdown text={m.text} />
      </div>
    </div>
  )
}

export function ChatPane({ agent, active }: { agent: Agent; active: boolean }) {
  const { sendChatMessage } = useActions()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const log = agent.chatLog ?? []
  const busy = agent.status === 'running'

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length, busy])

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  const send = () => {
    if (!draft.trim() || busy) return
    sendChatMessage(agent.id, draft)
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#0A0B0F' }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        {log.map(m => <Bubble key={m.id} m={m} />)}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 10px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>working…</span>
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '10px 12px', flexShrink: 0 }}>
        <div style={{ background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 11, padding: '8px 11px' }}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={busy ? 'working — one message at a time…' : 'Message this agent — it can edit files, run commands, load skills, call MCP tools…'}
            rows={2}
            style={{
              width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none',
              color: 'var(--text)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 13, lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>
              {agent.cwd || 'no working folder'} · ↩ send
            </span>
            <button className="send-btn" onClick={send} style={{ width: 28, height: 28, opacity: draft.trim() && !busy ? 1 : 0.45 }}>
              <Icon paths={IC.send} size={14} stroke={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
