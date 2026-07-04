import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useActions, useConductor } from '../store'
import { isTauri, pickFolder } from '../native'
import { ACCENT, hexToRgba } from '../data'
import type { Agent, BoardCol, BoardTask, TaskChatMsg } from '../types'
import { IC, Icon, ViewHeader } from './ui'
import { Markdown } from './Markdown'

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
} as const

/** Convert an epoch timestamp to a datetime-local input value. */
function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

/** Render a board-dialog field label and optional inline guidance. */
function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.3 }}>{children}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{hint}</span>}
    </div>
  )
}

// ---------- creation dialog: LLM helps fill in context, or rejects vague tasks ----------

/** Draft, validate, and create a watcher-ready board task. */
function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const s = useConductor()
  const { createTask, draftTask } = useActions()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [criteria, setCriteria] = useState('')
  const [runWith, setRunWith] = useState('')
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')
  const [busy, setBusy] = useState<'draft' | 'create' | null>(null)
  const [questions, setQuestions] = useState<string[]>([])
  const [error, setError] = useState('')
  const llmOn = s.settings.masterEnabled
  const enabledTypes = s.agentTypes.filter(t => t.enabled)
  const templates = s.templates ?? []

  // Fill the task working directory from the native folder picker.
  const browse = async () => {
    const dir = await pickFolder(cwd || undefined)
    if (dir) setCwd(dir)
  }

  // Translate the combined run selector into mutually exclusive task fields.
  const runConfig = () => runWith.startsWith('tpl:')
    ? { templateId: runWith.slice(4) }
    : { typeId: runWith || undefined }

  // Normalize the criteria textarea into a non-empty string list.
  const parsedCriteria = () => criteria.split('\n').map(c => c.replace(/^[-•]\s*/, '').trim()).filter(Boolean)

  // Ask the task-spec assistant to complete the current draft in place.
  const draft = async () => {
    if (!title.trim() || busy) return
    setBusy('draft')
    setError('')
    setQuestions([])
    try {
      const res = await draftTask({ title: title.trim(), description: description.trim(), criteria: parsedCriteria() })
      if (!res) { setError('No brain configured — enable LLM Master in Settings to draft with AI.'); return }
      if (!res.ok) { setQuestions(res.questions.length ? res.questions : ['Add more detail — the assistant could not write a concrete spec.']); return }
      setDescription(res.description)
      setCriteria(res.criteria.join('\n'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Validate the form, optionally improve it with the LLM, and add the task.
  const create = async () => {
    if (!title.trim() || busy) return
    setError('')
    setQuestions([])
    const crit = parsedCriteria()
    if (llmOn) {
      // the LLM completes the spec — or rejects the task and asks for more info
      setBusy('create')
      try {
        const res = await draftTask({ title: title.trim(), description: description.trim(), criteria: crit })
        if (res && !res.ok) {
          setQuestions(res.questions.length ? res.questions : ['This task is too vague — describe what should happen and how to verify it.'])
          return
        }
        createTask({
          title: title.trim(),
          description: res?.description ?? description.trim(),
          criteria: res?.criteria ?? crit,
          cwd: cwd.trim() || undefined,
          ...runConfig(),
        })
        onClose()
        return
      } catch {
        // brain unreachable — fall through to manual validation
      } finally {
        setBusy(null)
      }
    }
    if (!description.trim() || !crit.length) {
      setQuestions(['No brain is available to fill in the gaps — write a clear description and at least one acceptance criterion.'])
      return
    }
    createTask({ title: title.trim(), description: description.trim(), criteria: crit, cwd: cwd.trim() || undefined, ...runConfig() })
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '10vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 560, maxWidth: '94vw', maxHeight: '80vh', overflowY: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 20 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New task</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          A good task has a clear description and verifiable criteria — its watcher uses them to drive a one-shot agent and judge the result.
          {llmOn ? ' The assistant fills in gaps, or asks questions when the idea is too vague.' : ''}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <FieldLabel>Title</FieldLabel>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Fix flaky login e2e test" style={FIELD} />
          </div>
          <div>
            <FieldLabel hint="what needs to be done — concrete enough for a one-shot agent">Description</FieldLabel>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="What, where, and any context the agent needs…" style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5 }} />
          </div>
          <div>
            <FieldLabel hint="one per line — the watcher verifies these before done">Acceptance criteria</FieldLabel>
            <textarea value={criteria} onChange={e => setCriteria(e.target.value)} rows={3} placeholder={'tests pass locally\nno console errors on login page'} style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <FieldLabel hint="agent type or template">Run with</FieldLabel>
              <select value={runWith} onChange={e => setRunWith(e.target.value)} className="select-field" style={FIELD}>
                <option value="">default · {enabledTypes[0]?.name ?? 'first enabled type'}</option>
                {enabledTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                {templates.length > 0 && (
                  <optgroup label="Templates">
                    {templates.map(t => <option key={t.id} value={`tpl:${t.id}`}>{t.name} · {t.mode === 'ephemeral' ? 'one-shot' : 'interactive'}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
            <div>
              <FieldLabel>Working folder</FieldLabel>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="default" style={{ ...FIELD, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }} />
                <button className="open-btn" style={{ flex: 'none', padding: '0 11px', fontSize: 11.5 }} onClick={browse} disabled={!isTauri}>…</button>
              </div>
            </div>
          </div>
          {questions.length > 0 && (
            <div style={{ border: '1px solid rgba(255,176,32,.4)', background: 'rgba(255,176,32,.07)', borderRadius: 10, padding: '10px 13px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 6 }}>Needs more info before it can be created</div>
              {questions.map((q, i) => (
                <div key={i} style={{ fontSize: 12, color: '#C7CCD6', lineHeight: 1.5, marginBottom: 3 }}>• {q}</div>
              ))}
            </div>
          )}
          {error && <div style={{ fontSize: 11.5, color: 'var(--red-soft)' }}>{error}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {llmOn && (
            <button className="open-btn" style={{ flex: 'none', padding: '9px 14px', opacity: title.trim() && !busy ? 1 : 0.45 }} onClick={draft} disabled={!title.trim() || !!busy}>
              {busy === 'draft' ? 'Drafting…' : '✦ Draft with AI'}
            </button>
          )}
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: title.trim() && !busy ? 1 : 0.45 }} onClick={create} disabled={!title.trim() || !!busy}>
            {busy === 'create' ? 'Checking…' : 'Create task'}
          </button>
          <button className="deny-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ---------- task drawer: spec + watcher chat ----------

/** Render one user, watcher, or system message from a task conversation. */
function ChatBubble({ m }: { m: TaskChatMsg }) {
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

/** Edit a task specification and converse with its dedicated watcher. */
function TaskDrawer({ task, agent, onClose }: { task: BoardTask; agent: Agent | null; onClose: () => void }) {
  const s = useConductor()
  const { updateTask, sendTaskChat, focusTab, startTask, restartTask, deleteTask } = useActions()
  const runWith = task.templateId
    ? `template · ${(s.templates ?? []).find(t => t.id === task.templateId)?.name ?? task.templateId}`
    : (s.agentTypes.find(t => t.id === task.typeId)?.name ?? 'default agent type')
  const [draft, setDraft] = useState('')
  const [editingSpec, setEditingSpec] = useState(false)
  const [descDraft, setDescDraft] = useState(task.description ?? '')
  const [critDraft, setCritDraft] = useState((task.criteria ?? []).join('\n'))
  const [cwdDraft, setCwdDraft] = useState(task.cwd ?? '')
  const scrollRef = useRef<HTMLDivElement>(null)
  const chat = task.chat ?? []

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length])

  // Post the current draft to the task watcher and clear the composer.
  const send = () => {
    if (!draft.trim()) return
    sendTaskChat(task.id, draft)
    setDraft('')
  }
  // Send on Enter while preserving Shift+Enter for multiline input.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }
  // Persist edited task fields after trimming blank acceptance criteria.
  const saveSpec = () => {
    updateTask(task.id, {
      description: descDraft.trim(),
      criteria: critDraft.split('\n').map(c => c.replace(/^[-•]\s*/, '').trim()).filter(Boolean),
      cwd: cwdDraft.trim() || undefined,
    })
    setEditingSpec(false)
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.5)', zIndex: 42 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 460, maxWidth: '92vw', background: 'var(--panel)',
        borderLeft: '1px solid var(--line2)', zIndex: 43, display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 60px rgba(0,0,0,.45)',
      }}>
        <div style={{ padding: '15px 17px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>{task.title}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: '1px 7px', borderRadius: 5, color: 'var(--mut)', border: '1px solid var(--line2)' }}>
                {task.col.toUpperCase()}
              </span>
              {task.awaitingUser && (
                <span className="mono" style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 5, color: 'var(--amber)', border: '1px solid rgba(255,176,32,.4)' }}>
                  WAITING ON YOU
                </span>
              )}
              {agent ? (
                <>
                  <button onClick={() => focusTab(agent.id)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', color: '#9AA3B2', fontSize: 11, padding: 0 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent.color }} />
                    {agent.name} — open session
                  </button>
                  {(agent.status === 'idle' || agent.status === 'error') && task.col !== 'done' && (
                    <button
                      title="Detach the finished session and spawn a fresh one-shot for this task"
                      onClick={() => restartTask(task.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--green)', fontSize: 11, fontWeight: 600, padding: 0 }}
                    >
                      <Icon paths={['M4 12a8 8 0 0113.6-5.7L20 8.5', 'M20 3.5v5h-5', 'M20 12a8 8 0 01-13.6 5.7L4 15.5', 'M4 20.5v-5h5']} size={11} stroke={1.8} />
                      Relaunch
                    </button>
                  )}
                </>
              ) : (
                <button onClick={() => startTask(task.id)} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--green)', fontSize: 11, fontWeight: 600, padding: 0 }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
                  Start session
                </button>
              )}
            </div>
          </div>
          <button className="icon-btn danger" title="Delete task" style={{ width: 26, height: 26, borderRadius: 7 }} onClick={() => { deleteTask(task.id); onClose() }}>
            <Icon paths={IC.close} size={12} stroke={1.8} />
          </button>
          <button className="icon-btn" title="Close" style={{ width: 26, height: 26, borderRadius: 7 }} onClick={onClose}>
            <Icon paths={['M9 6l6 6-6 6']} size={13} stroke={1.8} />
          </button>
        </div>

        <div style={{ padding: '12px 17px', borderBottom: '1px solid var(--line)', flexShrink: 0, maxHeight: '38%', overflowY: 'auto' }}>
          {editingSpec ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <FieldLabel>Description</FieldLabel>
                <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={4} style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5, fontSize: 12 }} />
              </div>
              <div>
                <FieldLabel hint="one per line">Criteria</FieldLabel>
                <textarea value={critDraft} onChange={e => setCritDraft(e.target.value)} rows={3} style={{ ...FIELD, resize: 'vertical', fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }} />
              </div>
              <div>
                <FieldLabel hint="used when (re)launching the session">Working folder</FieldLabel>
                <input value={cwdDraft} onChange={e => setCwdDraft(e.target.value)} placeholder="default" style={{ ...FIELD, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="approve-btn" style={{ padding: '6px 16px', fontSize: 11.5 }} onClick={saveSpec}>Save</button>
                <button className="deny-btn" style={{ padding: '6px 16px', fontSize: 11.5 }} onClick={() => setEditingSpec(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.3 }}>SPEC</span>
                <button
                  className="icon-btn" title="Edit description & criteria" style={{ width: 22, height: 22, borderRadius: 6, marginLeft: 6 }}
                  onClick={() => { setDescDraft(task.description ?? ''); setCritDraft((task.criteria ?? []).join('\n')); setEditingSpec(true) }}
                >
                  <Icon paths={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z']} size={11} stroke={1.8} />
                </button>
              </div>
              <div style={{ fontSize: 12.5, color: '#C7CCD6', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                {task.description || <span style={{ color: 'var(--dim)' }}>No description.</span>}
              </div>
              {(task.criteria ?? []).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {(task.criteria ?? []).map((c, i) => (
                    <div key={i} style={{ display: 'flex', gap: 7, fontSize: 12, color: 'var(--mut)', lineHeight: 1.6 }}>
                      <span style={{ color: 'var(--accent)' }}>◇</span>{c}
                    </div>
                  ))}
                </div>
              )}
              <div className="mono" style={{ marginTop: 8, fontSize: 10.5, color: 'var(--dim)' }}>
                runs with {runWith}{task.cwd ? ` · ${task.cwd}` : ''}
              </div>
              {task.watcherNote && (
                <div className="mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--accent)' }}>⌁ {task.watcherNote}</div>
              )}
            </>
          )}
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 17px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {chat.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', paddingTop: 20, lineHeight: 1.6 }}>
              This task's watcher chats here once a session is started —<br />progress notes, questions, and your replies.
            </div>
          )}
          {chat.map(m => <ChatBubble key={m.id} m={m} />)}
        </div>

        <div style={{ borderTop: '1px solid var(--line)', padding: '11px 13px' }}>
          <div style={{ background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 11, padding: '9px 11px' }}>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="Message the task's watcher…"
              rows={2}
              style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--text)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 12.5, lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="send-btn" onClick={send} style={{ width: 30, height: 30 }}>
                <Icon paths={IC.send} size={15} stroke={2.2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ---------- board ----------

/** Configure or clear a board task's one-time launch time and template. */
function SchedulePopover({ card, onClose }: { card: BoardTask; onClose: () => void }) {
  const s = useConductor()
  const { scheduleTask } = useActions()
  const [when, setWhen] = useState(card.scheduleAt ? toLocalInput(card.scheduleAt) : toLocalInput(Date.now() + 3600_000))
  const [templateId, setTemplateId] = useState(card.templateId ?? '')

  const field = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 7,
    padding: '6px 9px', color: 'var(--text)', outline: 'none', fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace", colorScheme: 'dark',
  } as const

  return (
    <div onClick={e => e.stopPropagation()} style={{
      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4,
      background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 10,
      boxShadow: '0 14px 40px rgba(0,0,0,.5)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.4 }}>SCHEDULE SESSION START</div>
      <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={field} />
      <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="select-field" style={field}>
        <option value="">default agent type</option>
        {(s.templates ?? []).map(t => <option key={t.id} value={t.id}>template · {t.name} ({t.mode})</option>)}
      </select>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="approve-btn"
          style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }}
          onClick={() => {
            const at = new Date(when).getTime()
            if (!Number.isNaN(at)) scheduleTask(card.id, at, templateId || null)
            onClose()
          }}
        >
          Set
        </button>
        {card.scheduleAt && (
          <button className="deny-btn" style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }} onClick={() => { scheduleTask(card.id, null, null); onClose() }}>
            Clear
          </button>
        )}
        <button className="deny-btn" style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

/** Render a draggable task summary with worker and watcher status. */
function Card({ card, agent, onOpen }: { card: BoardTask; agent: Agent | null; onOpen: () => void }) {
  const s = useConductor()
  const { startCardDrag, deleteTask, startTask } = useActions()
  const [scheduling, setScheduling] = useState(false)
  const unread = (card.chat ?? []).length

  return (
    <div
      className="board-card"
      draggable
      onDragStart={e => {
        startCardDrag(card.id)
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', card.id) } catch { /* older webviews */ }
      }}
      onClick={onOpen}
      style={{
        background: 'var(--panel2)', border: `1px solid ${card.awaitingUser ? 'rgba(255,176,32,.5)' : 'var(--line)'}`,
        borderLeft: `3px solid ${agent ? agent.color : 'var(--dim)'}`,
        borderRadius: 10, padding: '11px 12px', cursor: 'pointer', position: 'relative',
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.38, paddingRight: 16 }}>{card.title}</div>
      {card.description && (
        <div style={{ fontSize: 11, color: 'var(--mut)', lineHeight: 1.45, marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {card.description}
        </div>
      )}
      {card.awaitingUser ? (
        <div className="mono" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--amber)' }}>? waiting on you — open the chat</div>
      ) : card.watcherNote ? (
        <div className="mono" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⌁ {card.watcherNote}</div>
      ) : null}
      <button
        className="card-delete"
        title="Delete task"
        onClick={e => { e.stopPropagation(); deleteTask(card.id) }}
        style={{
          position: 'absolute', top: 6, right: 6, width: 20, height: 20, border: 'none',
          background: 'transparent', color: 'var(--dim)', borderRadius: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon paths={IC.close} size={11} stroke={2} />
      </button>
      {card.scheduleAt && !agent && (
        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7, fontSize: 10.5, color: 'var(--accent)' }}>
          <Icon paths={['M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0', 'M12 7v5l3 3']} size={11} stroke={1.8} />
          {new Date(card.scheduleAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          {card.templateId ? ` · ${(s.templates ?? []).find(t => t.id === card.templateId)?.name ?? ''}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent ? agent.color : 'var(--dim)', flexShrink: 0 }} />
        {agent ? (
          <span style={{ fontSize: 11, color: '#9AA3B2', whiteSpace: 'nowrap' }}>{agent.name}</span>
        ) : (
          <button
            title="Spawn a one-shot session; the task's watcher drives it"
            onClick={e => { e.stopPropagation(); startTask(card.id) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none',
              color: 'var(--green)', fontSize: 11, fontWeight: 600, padding: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
            Start
          </button>
        )}
        {!agent && (
          <button
            title={card.scheduleAt ? 'Change scheduled start' : 'Schedule session start'}
            onClick={e => { e.stopPropagation(); setScheduling(v => !v) }}
            style={{
              display: 'flex', alignItems: 'center', background: 'transparent', border: 'none',
              color: card.scheduleAt ? 'var(--accent)' : 'var(--dim)', padding: 0,
            }}
          >
            <Icon paths={['M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0', 'M12 7v5l3 3']} size={12} stroke={1.8} />
          </button>
        )}
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          {(card.criteria ?? []).length > 0 && <span title="acceptance criteria">◇ {(card.criteria ?? []).length}</span>}
          {unread > 0 && <span title="chat messages">💬 {unread}</span>}
        </span>
      </div>
      {scheduling && <SchedulePopover card={card} onClose={() => setScheduling(false)} />}
    </div>
  )
}

const COLS: Array<{ id: BoardCol; label: string; dot: string }> = [
  { id: 'backlog', label: 'Backlog', dot: '#6B7280' },
  { id: 'routed', label: 'Routed', dot: '#6C8EF5' },
  { id: 'progress', label: 'In progress', dot: '#3DDC97' },
  { id: 'review', label: 'Needs review', dot: '#FFB020' },
  { id: 'done', label: 'Done', dot: '#4a5262' },
  { id: 'failed', label: 'Failed', dot: '#E5636F' },
]

/** Render the active workspace's draggable watcher-driven kanban board. */
export function Board() {
  const s = useConductor()
  const { enterCol, dropTo } = useActions()
  const [creating, setCreating] = useState(false)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const byId = new Map(s.agents.map(a => [a.id, a]))
  const openTask = openTaskId ? s.tasks.find(t => t.id === openTaskId) : undefined

  // Enable column drops while a store-tracked card drag is active.
  const allowDrop = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Task board">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Each started task gets a one-shot session driven by its own watcher — click a card for details & chat</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setCreating(true)}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New task
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', padding: 16, display: 'flex', gap: 14 }}>
        {COLS.map(col => {
          const cards = s.tasks.filter(t => t.col === col.id)
          return (
            <div
              key={col.id}
              onDragOver={allowDrop}
              onDragEnter={() => enterCol(col.id)}
              onDrop={e => { e.preventDefault(); dropTo(col.id) }}
              style={{
                width: 258, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#0B0C10',
                border: `1px solid ${s.dragOverCol === col.id ? ACCENT : '#1a1e26'}`,
                borderRadius: 14, minHeight: 0, transition: 'border-color .12s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 14px', borderBottom: '1px solid #1a1e26', flexShrink: 0 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: col.dot }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{col.label}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--mut)', background: 'var(--panel2)', borderRadius: 6, padding: '1px 8px', marginLeft: 2 }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {cards.map(card => (
                  <Card
                    key={card.id}
                    card={card}
                    agent={card.agentId ? byId.get(card.agentId) || null : null}
                    onOpen={() => setOpenTaskId(card.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {creating && <NewTaskDialog onClose={() => setCreating(false)} />}
      {openTask && (
        <TaskDrawer
          task={openTask}
          agent={openTask.agentId ? byId.get(openTask.agentId) || null : null}
          onClose={() => setOpenTaskId(null)}
        />
      )}
    </div>
  )
}
