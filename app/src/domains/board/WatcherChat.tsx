import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import type { BoardTask, TaskChatMsg } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'

// The task-watcher conversation, shared by the board's TaskDrawer and Mission
// Control's Watcher tab: bubbles + live stream + composer. Also hosts the
// review footer (feedback → watcher, request changes, approve & merge) so both
// surfaces close the loop through the same component.

/** Render one user, watcher, or system message from a task conversation. */
export function ChatBubble({ m }: { m: TaskChatMsg }) {
  if (m.role === 'system') {
    return (
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', textAlign: 'center', padding: '2px 0' }}>
        · {m.text} ·
      </div>
    )
  }
  const user = m.role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: user ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '85%', minWidth: 0, borderRadius: 11, padding: '8px 11px', fontSize: 12.5, lineHeight: 1.5,
        background: user ? hexToRgba(ACCENT, 0.14) : 'var(--panel2)',
        border: `1px solid ${user ? hexToRgba(ACCENT, 0.3) : 'var(--line2)'}`,
        color: 'var(--text)',
      }}>
        {!user && <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--accent)', marginBottom: 3 }}>WATCHER</div>}
        <Markdown text={m.text} />
      </div>
    </div>
  )
}

/** Scrolling watcher conversation with live stream and a composer. */
export function WatcherChat({ task }: { task: BoardTask }) {
  const stream = useConductorSelector(x => x.taskStreams?.[task.id] ?? '')
  const { sendTaskChat } = useActions()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const chat = task.chat ?? []

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, stream])

  const send = () => {
    if (!draft.trim()) return
    sendTaskChat(task.id, draft)
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 17px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {chat.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', paddingTop: 20, lineHeight: 1.6 }}>
            This task's watcher chats here once a session is started —<br />progress notes, questions, and your replies.
          </div>
        )}
        {chat.map(m => <ChatBubble key={m.id} m={m} />)}
        {stream && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{
              maxWidth: '85%', minWidth: 0, borderRadius: 11, padding: '8px 11px', fontSize: 12.5, lineHeight: 1.5,
              background: 'var(--panel2)', border: '1px solid var(--line2)', color: 'var(--text)',
            }}>
              <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: 'var(--accent)', marginBottom: 3 }}>WATCHER</div>
              <Markdown text={stream} />
              <span className="stream-caret" />
            </div>
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '11px 13px', flexShrink: 0 }}>
        <div style={{ background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 11, padding: '9px 11px' }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message the task's watcher…"
            rows={2}
            style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="send-btn" onClick={send} style={{ width: 30, height: 30 }}>
              <Icon paths={IC.send} size={15} stroke={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Review-tab actions: feedback to the watcher chat, approve & merge, request changes. */
export function TaskReviewFooter({ task, onClose }: { task: BoardTask; onClose: () => void }) {
  const { approveTaskReview, rejectTaskReview, sendTaskChat } = useActions()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const approve = async () => {
    setBusy(true)
    setErr('')
    const e = await approveTaskReview(task.id)
    setBusy(false)
    if (e) setErr(e)
    else onClose()
  }
  return (
    <>
      {err && (
        <div className="mono" style={{ borderTop: '1px solid var(--line)', padding: '9px 16px', fontSize: 11, color: 'var(--red-soft)', whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' }}>
          {err}
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--line)', padding: '11px 15px', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Feedback — sent to the task's watcher…"
          rows={2}
          style={{
            flex: 1, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
            padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12, resize: 'vertical',
            fontFamily: 'var(--font-sans)',
          }}
        />
        <button
          className="open-btn"
          title="Send feedback to the watcher without changing the task's column"
          style={{ flex: 'none', padding: '8px 12px', fontSize: 11.5, opacity: comment.trim() ? 1 : 0.5 }}
          disabled={!comment.trim()}
          onClick={() => { sendTaskChat(task.id, comment.trim()); setComment('') }}
        >
          Send
        </button>
        <button
          className="deny-btn"
          style={{ flex: 'none', padding: '8px 14px', fontSize: 12 }}
          disabled={busy}
          title="Bounce the task to In progress; your feedback becomes the watcher's next instruction"
          onClick={() => { rejectTaskReview(task.id, comment); onClose() }}
        >
          Request changes
        </button>
        <button
          className="approve-btn"
          style={{ flex: 'none', padding: '8px 16px', fontSize: 12, opacity: busy ? 0.6 : 1 }}
          disabled={busy}
          onClick={() => { void approve() }}
        >
          {busy ? 'Merging…' : 'Approve & merge'}
        </button>
      </div>
    </>
  )
}
