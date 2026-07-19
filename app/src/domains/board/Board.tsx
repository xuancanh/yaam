import { useEffect, useState } from 'react'
import type { DragEvent } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { ACCENT } from '../../core/data'
import type { Agent, BoardCol, BoardTask } from '../../core/types'
import { IC, Icon, ViewHeader } from '../../components/ui'
import { SpecVerifyDialog, TaskSpecFields, emptyTaskSpec, useTaskSpecAssist } from './TaskSpecForm'
import type { TaskSpecPatch, VerifyOutcome } from './TaskSpecForm'
import { ReviewPanel } from './ReviewPanel'
import { GitWorkbench } from '../session/GitPanel'
import { TaskReviewFooter, WatcherChat } from './WatcherChat'
import { confirmAction } from '../../components/Confirm'
import { HistoryList } from '../../components/HistoryList'

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: 'var(--font-sans)',
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

/** Verify (AI-gated when a brain is configured) and create a board task. AI
 *  feedback is surfaced in a confirmation popup — never applied silently. */
function NewTaskDialog({ onClose }: { onClose: () => void }) {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { createTask } = useActions()
  const [spec, setSpec] = useState(() => emptyTaskSpec(s.settings.defaultCwd || ''))
  const { busy, error, llmOn, verifyForCreate } = useTaskSpecAssist(spec)
  const [confirm, setConfirm] = useState<Extract<VerifyOutcome, { kind: 'ai' | 'questions' }> | null>(null)

  const create = (patch: TaskSpecPatch) => {
    createTask(patch)
    onClose()
  }
  const verify = async () => {
    const out = await verifyForCreate()
    if (!out) return
    if (out.kind === 'create') create(out.patch)
    else setConfirm(out)
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
          A good task has a clear description and verifiable criteria — its watcher uses them to drive the agent and judge the result.
          {llmOn ? ' Verification flags gaps and proposes fixes; nothing changes without your say-so.' : ''}
        </div>
        <TaskSpecFields v={spec} set={setSpec} questions={[]} error={error} autoFocus />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: spec.title.trim() && !busy ? 1 : 0.45 }} onClick={() => { void verify() }} disabled={!spec.title.trim() || busy}>
            {busy ? 'Verifying…' : llmOn ? 'Verify & create' : 'Create task'}
          </button>
          <button className="deny-btn" style={{ flex: 'none', padding: '9px 16px' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
      {confirm && <SpecVerifyDialog outcome={confirm} onCreate={create} onClose={() => setConfirm(null)} />}
    </div>
  )
}

// ---------- task drawer: spec + watcher chat ----------

function TaskDrawer({ task, agent, onClose }: { task: BoardTask; agent: Agent | null; onClose: () => void }) {
  const s = useConductorSelector(x => ({ templates: x.templates, agentTypes: x.agentTypes, agents: x.agents }), shallowEqual)
  const { updateTask, focusTab, startTask, restartTask, archiveTask } = useActions()
  const [view, setView] = useState<'chat' | 'review' | 'history'>('chat')
  // the task's worktree, if any of its sessions ran isolated
  const worktree = (task.agentIds ?? [])
    .map(aid => s.agents.find(a => a.id === aid)?.worktree)
    .find(Boolean)
  const runWith = task.templateId
    ? `template · ${(s.templates ?? []).find(t => t.id === task.templateId)?.name ?? task.templateId}`
    : (s.agentTypes.find(t => t.id === task.typeId)?.name ?? 'default agent type')
  const [editingSpec, setEditingSpec] = useState(false)
  const [descDraft, setDescDraft] = useState(task.description ?? '')
  const [critDraft, setCritDraft] = useState((task.criteria ?? []).join('\n'))
  const [cwdDraft, setCwdDraft] = useState(task.cwd ?? '')
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
        position: 'fixed', top: 0, right: 0, bottom: 0, width: view === 'review' ? 960 : 460, maxWidth: '94vw', background: 'var(--panel)',
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
                  <button onClick={() => focusTab(agent.id)} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'transparent', border: 'none', color: 'var(--mut2)', fontSize: 11, padding: 0 }}>
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
          <button
            className="icon-btn"
            title={view === 'history' ? 'Back to the watcher chat' : 'History — your actions and decisions on this task'}
            style={{ width: 26, height: 26, borderRadius: 7, color: view === 'history' ? 'var(--accent)' : undefined }}
            onClick={() => setView(v => (v === 'history' ? 'chat' : 'history'))}
          >
            <Icon paths={['M12 7v5l3 2', 'M12 3a9 9 0 100 18 9 9 0 000-18z']} size={13} stroke={1.7} />
          </button>
          <button
            className="icon-btn"
            title={view === 'chat' ? 'Review the task\'s changes (diff, stage, commit, approve)' : 'Back to the watcher chat'}
            style={{ width: 26, height: 26, borderRadius: 7, color: view === 'review' ? 'var(--accent)' : worktree ? 'var(--amber)' : undefined }}
            onClick={() => setView(v => (v === 'chat' ? 'review' : 'chat'))}
          >
            <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={13} stroke={1.7} />
          </button>
          <button
            className="icon-btn danger"
            title="Archive task (recoverable — delete lives in the Archived viewer)"
            style={{ width: 26, height: 26, borderRadius: 7 }}
            onClick={() => {
              void confirmAction({
                title: `Archive “${task.title.slice(0, 48)}”?`,
                detail: 'The task leaves the board and its watcher stops. Restore it anytime from Archived on the board header.',
                confirmLabel: 'Archive', danger: false,
              }).then(ok => { if (ok) { archiveTask(task.id); onClose() } })
            }}
          >
            <Icon paths={IC.close} size={12} stroke={1.8} />
          </button>
          <button className="icon-btn" title="Close" style={{ width: 26, height: 26, borderRadius: 7 }} onClick={onClose}>
            <Icon paths={['M9 6l6 6-6 6']} size={13} stroke={1.8} />
          </button>
        </div>

        {view === 'review' ? (
          <GitWorkbench
            cwd={worktree?.workdir ?? agent?.cwd ?? task.cwd}
            worktree={worktree}
            footer={<TaskReviewFooter task={task} onClose={onClose} />}
          />
        ) : (
        <>
        <div style={{ padding: '12px 17px', borderBottom: '1px solid var(--line)', flexShrink: 0, maxHeight: '38%', overflowY: 'auto' }}>
          {editingSpec ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <FieldLabel>Description</FieldLabel>
                <textarea value={descDraft} onChange={e => setDescDraft(e.target.value)} rows={4} style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5, fontSize: 12 }} />
              </div>
              <div>
                <FieldLabel hint="one per line">Criteria</FieldLabel>
                <textarea value={critDraft} onChange={e => setCritDraft(e.target.value)} rows={3} style={{ ...FIELD, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
              </div>
              <div>
                <FieldLabel hint="used when (re)launching the session">Working folder</FieldLabel>
                <input value={cwdDraft} onChange={e => setCwdDraft(e.target.value)} placeholder="default" style={{ ...FIELD, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
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
              <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
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

        {view === 'history' ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <HistoryList entries={task.history} emptyHint="No actions or decisions yet — they'll be logged here as you work this task." />
          </div>
        ) : (
          <WatcherChat task={task} />
        )}
        </>
        )}
      </div>
    </>
  )
}

// ---------- archived tasks: restore, or the ONLY place to hard-delete ----------

function ArchivedTasks({ onClose }: { onClose: () => void }) {
  const s = useConductorSelector(x => ({ tasks: x.tasks }), shallowEqual)
  const { restoreTask, deleteTask } = useActions()
  const archived = s.tasks.filter(t => t.archived)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw', maxHeight: '72vh', display: 'flex', flexDirection: 'column', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span className="grotesk" style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>Archived tasks</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--mut)' }}>{archived.length}</span>
          <button className="icon-btn" style={{ width: 26, height: 26, borderRadius: 7 }} onClick={onClose}>
            <Icon paths={IC.close} size={12} stroke={2} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 12px' }}>
          {archived.length === 0 && (
            <div style={{ padding: '22px 8px', fontSize: 12, color: 'var(--dim)', textAlign: 'center', lineHeight: 1.6 }}>
              Nothing here — archiving a task (the ✕ on a card, or the drawer) moves it into this list.
            </div>
          )}
          {archived.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 6px', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
                  was in {t.col}{t.cwd ? ` · ${t.cwd}` : ''}
                </div>
              </div>
              <button className="open-btn" style={{ flex: 'none', padding: '5px 12px', fontSize: 11.5 }} onClick={() => restoreTask(t.id)}>
                Restore
              </button>
              <button
                className="deny-btn"
                style={{ flex: 'none', padding: '5px 12px', fontSize: 11.5, color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
                onClick={() => {
                  void confirmAction({
                    title: `Delete “${t.title.slice(0, 48)}”?`,
                    detail: 'Permanently removes the task, its watcher chat, and its history. This cannot be undone.',
                  }).then(ok => { if (ok) deleteTask(t.id) })
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- board ----------

/** Configure or clear a board task's one-time launch time and template. */
function SchedulePopover({ card, onClose }: { card: BoardTask; onClose: () => void }) {
  const s = useConductorSelector(x => ({ templates: x.templates }), shallowEqual)
  const { scheduleTask } = useActions()
  const [when, setWhen] = useState(card.scheduleAt ? toLocalInput(card.scheduleAt) : toLocalInput(Date.now() + 3600_000))
  const [templateId, setTemplateId] = useState(card.templateId ?? '')

  const field = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 7,
    padding: '6px 9px', color: 'var(--text)', outline: 'none', fontSize: 12,
    fontFamily: 'var(--font-mono)', colorScheme: 'dark',
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
function Card({ card, agent, onOpen, onReview }: { card: BoardTask; agent: Agent | null; onOpen: () => void; onReview: () => void }) {
  const s = useConductorSelector(x => ({ templates: x.templates }), shallowEqual)
  const { startCardDrag, archiveTask, startTask } = useActions()
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
        title="Archive task (recoverable)"
        onClick={e => {
          e.stopPropagation()
          void confirmAction({
            title: `Archive “${card.title.slice(0, 48)}”?`,
            detail: 'The task leaves the board and its watcher stops. Restore it anytime from Archived on the board header.',
            confirmLabel: 'Archive', danger: false,
          }).then(ok => { if (ok) archiveTask(card.id) })
        }}
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
          <span style={{ fontSize: 11, color: 'var(--mut2)', whiteSpace: 'nowrap' }}>{agent.name}</span>
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
      {card.col === 'review' && (
        <button
          title="Review the changes: diff, approve & merge, or request changes"
          onClick={e => { e.stopPropagation(); onReview() }}
          style={{
            width: '100%', marginTop: 9, padding: '6px 0', borderRadius: 8, cursor: 'pointer',
            background: 'rgba(255,176,32,.1)', border: '1px solid rgba(255,176,32,.4)',
            color: 'var(--amber)', fontSize: 11.5, fontWeight: 600,
          }}
        >
          Review changes{agent?.worktree ? ' · worktree' : ''}
        </button>
      )}
      {scheduling && <SchedulePopover card={card} onClose={() => setScheduling(false)} />}
    </div>
  )
}

const COLS: Array<{ id: BoardCol; label: string; dot: string }> = [
  { id: 'backlog', label: 'Backlog', dot: '#6B7280' },
  { id: 'progress', label: 'In progress', dot: '#3DDC97' },
  { id: 'review', label: 'Needs review', dot: '#FFB020' },
  { id: 'done', label: 'Done', dot: '#4a5262' },
  { id: 'failed', label: 'Failed', dot: '#E5636F' },
]

/** Render the active workspace's draggable watcher-driven kanban board. */
export function Board() {
  const s = useConductorSelector(x => ({ agents: x.agents, tasks: x.tasks, dragOverCol: x.dragOverCol, newTaskOpen: x.newTaskOpen, focusTaskId: x.focusTaskId }), shallowEqual)
  const { enterCol, dropTo, closeNewTask, clearBoardFocus } = useActions()
  const [creating, setCreating] = useState(false)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  // one-shot handoff from addon focusTask / deep links: open the requested
  // task's detail, then clear the flag so later visits start clean
  const { focusTaskId } = s
  useEffect(() => {
    if (!focusTaskId) return
    setOpenTaskId(focusTaskId)
    clearBoardFocus()
  }, [focusTaskId, clearBoardFocus])
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
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          Each started task gets a one-shot session driven by its own watcher — click a card for details & chat
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="open-btn"
          style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', color: 'var(--mut)' }}
          onClick={() => setArchivedOpen(true)}
          title="Archived tasks — restore them, or delete permanently (only possible here)"
        >
          Archived{s.tasks.filter(t => t.archived).length ? ` · ${s.tasks.filter(t => t.archived).length}` : ''}
        </button>
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setCreating(true)}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New task
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', padding: 16, display: 'flex', gap: 14 }}>
        {COLS.map(col => {
          const cards = s.tasks.filter(t => t.col === col.id && !t.archived)
          return (
            <div
              key={col.id}
              onDragOver={allowDrop}
              onDragEnter={() => enterCol(col.id)}
              onDrop={e => { e.preventDefault(); dropTo(col.id) }}
              style={{
                width: 258, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#0B0C10',
                border: `1px solid ${s.dragOverCol === col.id ? ACCENT : 'var(--line-soft)'}`,
                borderRadius: 14, minHeight: 0, transition: 'border-color .12s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 14px', borderBottom: '1px solid var(--line-soft)', flexShrink: 0 }}>
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
                    onReview={() => setReviewTaskId(card.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {(creating || s.newTaskOpen) && <NewTaskDialog onClose={() => { setCreating(false); closeNewTask() }} />}
      {archivedOpen && <ArchivedTasks onClose={() => setArchivedOpen(false)} />}
      {(() => {
        const reviewTask = reviewTaskId ? s.tasks.find(t => t.id === reviewTaskId) : undefined
        return reviewTask ? <ReviewPanel task={reviewTask} onClose={() => setReviewTaskId(null)} /> : null
      })()}
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
