import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { MEMORY_FILE_NAMES, wsMemory } from '../master/assistant-memory'
import { harnessStats } from '../master/harness-stats'
import type { HarnessRole } from '../../core/types'
import { SectionLabel } from './SectionLabel'

// Settings → Assistants: everything about the monitor/watcher/master/chat
// harness in one place — custom system-prompt appends per role, the shared
// multi-file memory (view/edit/prune), and the implicit-feedback scorecard
// (how often the user accepts what each role proposes).

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '8px 11px', color: 'var(--text)', outline: 'none', fontSize: 12, lineHeight: 1.5,
  fontFamily: 'var(--font-mono)', resize: 'vertical' as const,
}

const ROLES: Array<{ id: HarnessRole; label: string; hint: string }> = [
  { id: 'monitor', label: 'Session monitors', hint: 'one per terminal session — status cards, needs-input flags, suggested actions' },
  { id: 'watcher', label: 'Task watchers', hint: 'one per board task — spawns/steers sessions, moves cards, one-click options' },
  { id: 'master', label: 'Master', hint: 'the orchestrator in the left panel' },
  { id: 'chat', label: 'Chat agents', hint: 'in-app chat sessions' },
]

function PromptOverrides() {
  const settings = useConductorSelector(x => x.settings)
  const { updateSettings } = useActions()
  const prompts = settings.assistantPrompts ?? {}
  const set = (role: HarnessRole, v: string) =>
    updateSettings({ assistantPrompts: { ...prompts, [role]: v || undefined } })
  return (
    <>
      <SectionLabel>CUSTOM INSTRUCTIONS</SectionLabel>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.5 }}>
        Appended to each role's built-in system prompt — house rules, tone, what to escalate, what never to suggest.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24 }}>
        {ROLES.map(r => (
          <div key={r.id}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.label}</span>
              <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{r.hint}</span>
            </div>
            <textarea
              value={prompts[r.id] ?? ''}
              onChange={e => set(r.id, e.target.value)}
              placeholder="(no custom instructions)"
              rows={2}
              style={FIELD}
            />
          </div>
        ))}
      </div>
    </>
  )
}

function MemoryEditor() {
  const s = useConductorSelector(x => ({ assistantMemory: x.assistantMemory, activeWorkspace: x.activeWorkspace }), shallowEqual)
  const { setAssistantMemoryFile } = useActions()
  const files = wsMemory(s)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <SectionLabel>SHARED MEMORY</SectionLabel>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.5 }}>
        What the assistants have learned from your responses, arranged in files (this workspace). They search it with
        <span className="mono" style={{ color: 'var(--accent)' }}> memory_lookup</span> and the freshest lines ride along in their prompts. Edit or prune freely.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
        {MEMORY_FILE_NAMES.map(name => {
          const f = files.find(x => x.name === name)
          const lines = f?.content ? f.content.split('\n').filter(Boolean).length : 0
          const isOpen = open === name
          return (
            <div key={name} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10 }}>
              <button
                onClick={() => setOpen(isOpen ? null : name)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .12s', fontSize: 10, color: 'var(--dim)' }}>▸</span>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{name}.md</span>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{lines} entr{lines === 1 ? 'y' : 'ies'}</span>
                {f?.updatedAt ? (
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}>
                    {new Date(f.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
              </button>
              {isOpen && (
                <div style={{ padding: '0 13px 11px' }}>
                  <textarea
                    value={f?.content ?? ''}
                    onChange={e => setAssistantMemoryFile(name, e.target.value)}
                    placeholder="(empty — entries appear as you respond to prompts and suggestions)"
                    rows={Math.min(12, Math.max(3, lines + 1))}
                    style={FIELD}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function Scorecard() {
  const log = useConductorSelector(x => x.harnessLog)
  const stats = harnessStats(log)
  return (
    <>
      <SectionLabel>HARNESS SCORECARD</SectionLabel>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 12, lineHeight: 1.5 }}>
        Online evaluation from implicit feedback: every needs-input flag and suggestion is scored by what you did with it
        (clicked = accepted · cleared = dismissed). Each role sees its own precision as a calibration note in its prompt.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 14 }}>
        {ROLES.map(r => {
          const st = stats[r.id]
          const pct = st.precision === null ? '—' : `${Math.round(st.precision * 100)}%`
          const tone = st.precision === null ? 'var(--dim)' : st.precision < 0.4 ? 'var(--red-soft)' : st.precision > 0.8 ? 'var(--green)' : 'var(--amber)'
          return (
            <div key={r.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 13px' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text2)' }}>{r.label}</div>
              <div className="grotesk" style={{ fontSize: 22, fontWeight: 600, marginTop: 4, color: tone }}>{pct}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 3 }}>
                {st.shown} shown · {st.accepted} accepted · {st.dismissed} dismissed{st.pending ? ` · ${st.pending} pending` : ''}
              </div>
            </div>
          )
        })}
      </div>
      {!!(log ?? []).length && (
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 11, padding: '4px 0', marginBottom: 20, maxHeight: 220, overflowY: 'auto' }}>
          {(log ?? []).slice(0, 30).map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 13px', fontSize: 11.5, color: 'var(--mut)' }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: !d.outcome ? 'var(--dim)' : d.outcome === 'accepted' ? 'var(--green)' : 'var(--red-soft)',
              }} />
              <span className="mono" style={{ flexShrink: 0, fontSize: 10, color: 'var(--dim)', width: 52 }}>{d.role}</span>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.text}</span>
              <span className="mono" style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: 'var(--faint)' }}>
                {d.outcome ? `${d.outcome}${d.choice ? ` · ${d.choice.slice(0, 24)}` : ''}` : 'pending'}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Settings → Assistants: prompts, memory, and the harness scorecard. */
export function AssistantsSection() {
  return (
    <>
      <Scorecard />
      <PromptOverrides />
      <MemoryEditor />
    </>
  )
}
