import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { isTauri, pickFolder } from '../../core/native'

// Shared task-spec editor: the SAME fields, AI drafting, and reject-with-
// questions gate everywhere a task can be created (board "New task" dialog,
// schedule "add a task" action). A task spec is title + description +
// verifiable criteria + how to run it (template/agent type + working folder).

export interface TaskSpecValue {
  title: string
  description: string
  /** one criterion per line (textarea form) */
  criteria: string
  /** '' = default type · type id · 'tpl:<id>' = template */
  runWith: string
  cwd: string
  /** '' = local · saved machine id (SSH + tmux) */
  machineId: string
  /** run the task's sessions in an isolated git worktree */
  isolate: boolean
}

/** the createTask/boardTask-shaped patch a resolved spec produces */
export interface TaskSpecPatch {
  title: string
  description: string
  criteria: string[]
  templateId?: string
  typeId?: string
  cwd?: string
  machineId?: string
  isolate?: boolean
}

export function emptyTaskSpec(defaultCwd: string): TaskSpecValue {
  return { title: '', description: '', criteria: '', runWith: '', cwd: defaultCwd, machineId: '', isolate: false }
}

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: 'var(--font-sans)',
} as const

function FieldLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.3 }}>{children}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{hint}</span>}
    </div>
  )
}

function parsedCriteria(v: TaskSpecValue): string[] {
  return v.criteria.split('\n').map(c => c.replace(/^[-•]\s*/, '').trim()).filter(Boolean)
}

function toPatch(v: TaskSpecValue, description: string, criteria: string[]): TaskSpecPatch {
  return {
    title: v.title.trim(),
    description,
    criteria,
    cwd: v.cwd.trim() || undefined,
    machineId: v.machineId || undefined,
    isolate: v.isolate || undefined,
    ...(v.runWith.startsWith('tpl:') ? { templateId: v.runWith.slice(4) } : { typeId: v.runWith || undefined }),
  }
}

/** Drafting + validation shared by every task-creation surface. */
export function useTaskSpecAssist(v: TaskSpecValue, set: (v: TaskSpecValue) => void) {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { draftTask } = useActions()
  const [busy, setBusy] = useState<'draft' | 'create' | null>(null)
  const [questions, setQuestions] = useState<string[]>([])
  const [error, setError] = useState('')
  const llmOn = s.settings.masterEnabled

  // Ask the task-spec assistant to complete the current draft in place.
  const draft = async () => {
    if (!v.title.trim() || busy) return
    setBusy('draft')
    setError('')
    setQuestions([])
    try {
      const res = await draftTask({ title: v.title.trim(), description: v.description.trim(), criteria: parsedCriteria(v) })
      if (!res) { setError('No brain configured — enable LLM Master in Settings to draft with AI.'); return }
      if (!res.ok) { setQuestions(res.questions.length ? res.questions : ['Add more detail — the assistant could not write a concrete spec.']); return }
      set({ ...v, description: res.description, criteria: res.criteria.join('\n') })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /** Validate/complete the spec; null = rejected (questions shown), keep
   *  editing. `force` skips both the AI gate and the manual completeness
   *  check — the user knows what they want; create the task as written. */
  const resolveForCreate = async (force = false): Promise<TaskSpecPatch | null> => {
    if (!v.title.trim() || busy) return null
    setError('')
    setQuestions([])
    const crit = parsedCriteria(v)
    if (force) return toPatch(v, v.description.trim(), crit)
    if (llmOn) {
      setBusy('create')
      try {
        const res = await draftTask({ title: v.title.trim(), description: v.description.trim(), criteria: crit })
        if (res && !res.ok) {
          setQuestions(res.questions.length ? res.questions : ['This task is too vague — describe what should happen and how to verify it.'])
          return null
        }
        return toPatch(v, res?.description ?? v.description.trim(), res?.criteria ?? crit)
      } catch {
        // brain unreachable — fall through to manual validation
      } finally {
        setBusy(null)
      }
    }
    if (!v.description.trim() || !crit.length) {
      setQuestions(['No brain is available to fill in the gaps — write a clear description and at least one acceptance criterion.'])
      return null
    }
    return toPatch(v, v.description.trim(), crit)
  }

  return { busy, questions, error, llmOn, draft, resolveForCreate }
}

/** The task-spec fields, identical on every creation surface. */
export function TaskSpecFields({ v, set, questions, error, autoFocus }: {
  v: TaskSpecValue
  set: (v: TaskSpecValue) => void
  questions: string[]
  error: string
  autoFocus?: boolean
}) {
  // select the raw field: `?? []` here would mint a fresh array every
  // snapshot when machines is unset and loop useSyncExternalStore into a
  // "maximum update depth" crash — default AFTER selection instead
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes, templates: x.templates, machines: x.settings.machines }), shallowEqual)
  const machines = s.machines ?? []
  const enabledTypes = s.agentTypes.filter(t => t.enabled)
  const templates = s.templates ?? []

  const browse = async () => {
    const dir = await pickFolder(v.cwd || undefined)
    if (dir) set({ ...v, cwd: dir })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <FieldLabel>Title</FieldLabel>
        <input autoFocus={autoFocus} value={v.title} onChange={e => set({ ...v, title: e.target.value })} placeholder="e.g. Fix flaky login e2e test" style={FIELD} />
      </div>
      <div>
        <FieldLabel hint="what needs to be done — concrete enough for a one-shot agent">Description</FieldLabel>
        <textarea value={v.description} onChange={e => set({ ...v, description: e.target.value })} rows={4} placeholder="What, where, and any context the agent needs…" style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5 }} />
      </div>
      <div>
        <FieldLabel hint="one per line — the watcher verifies these before done">Acceptance criteria</FieldLabel>
        <textarea value={v.criteria} onChange={e => set({ ...v, criteria: e.target.value })} rows={3} placeholder={'tests pass locally\nno console errors on login page'} style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <FieldLabel hint="always runs one-shot">Run with</FieldLabel>
          <select value={v.runWith} onChange={e => set({ ...v, runWith: e.target.value })} className="select-field" style={FIELD}>
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
            <input value={v.cwd} onChange={e => set({ ...v, cwd: e.target.value })} placeholder={v.machineId ? 'remote folder' : 'default'} style={{ ...FIELD, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
            {!v.machineId && <button className="open-btn" style={{ flex: 'none', padding: '0 11px', fontSize: 11.5 }} onClick={browse} disabled={!isTauri}>…</button>}
          </div>
        </div>
      </div>
      {machines.length > 0 && (
        <div>
          <FieldLabel hint={v.machineId ? 'over SSH + tmux — the folder above is on the remote host' : 'this machine'}>Run on</FieldLabel>
          <select value={v.machineId} onChange={e => set({ ...v, machineId: e.target.value })} className="select-field" style={FIELD}>
            <option value="">This machine (local)</option>
            {machines.map(m => {
              const incomplete = !m.host?.trim() || !m.user?.trim()
              return <option key={m.id} value={m.id} disabled={incomplete}>{m.label || 'Unnamed'}{incomplete ? ' · incomplete' : ` · ${m.user}@${m.host}`}</option>
            })}
          </select>
        </div>
      )}
      {/* worktree isolation is local-only */}
      {!v.machineId && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', userSelect: 'none' }} title="The working folder (a git repo, or a folder whose subfolders are repos) is mirrored into git worktrees; the task's sessions work there and changes land via the review queue.">
          <input type="checkbox" checked={v.isolate} onChange={e => set({ ...v, isolate: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Isolate in a git worktree</span>
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--dim)', marginTop: 2 }}>
              Sessions work on a branch in a mirrored copy (multi-repo folders supported); approve &amp; merge from the Review column.
            </span>
          </span>
        </label>
      )}
      {questions.length > 0 && (
        <div style={{ border: '1px solid rgba(255,176,32,.4)', background: 'rgba(255,176,32,.07)', borderRadius: 10, padding: '10px 13px' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 6 }}>Needs more info before it can be created</div>
          {questions.map((q, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 3 }}>• {q}</div>
          ))}
        </div>
      )}
      {error && <div style={{ fontSize: 11.5, color: 'var(--red-soft)' }}>{error}</div>}
    </div>
  )
}
