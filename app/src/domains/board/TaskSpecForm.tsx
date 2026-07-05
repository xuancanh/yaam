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
}

/** the createTask/boardTask-shaped patch a resolved spec produces */
export interface TaskSpecPatch {
  title: string
  description: string
  criteria: string[]
  templateId?: string
  typeId?: string
  cwd?: string
}

export function emptyTaskSpec(defaultCwd: string): TaskSpecValue {
  return { title: '', description: '', criteria: '', runWith: '', cwd: defaultCwd }
}

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
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

  /** Validate/complete the spec; null = rejected (questions shown), keep editing. */
  const resolveForCreate = async (): Promise<TaskSpecPatch | null> => {
    if (!v.title.trim() || busy) return null
    setError('')
    setQuestions([])
    const crit = parsedCriteria(v)
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
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes, templates: x.templates }), shallowEqual)
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
        <textarea value={v.criteria} onChange={e => set({ ...v, criteria: e.target.value })} rows={3} placeholder={'tests pass locally\nno console errors on login page'} style={{ ...FIELD, resize: 'vertical', lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }} />
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
            <input value={v.cwd} onChange={e => set({ ...v, cwd: e.target.value })} placeholder="default" style={{ ...FIELD, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }} />
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
  )
}
