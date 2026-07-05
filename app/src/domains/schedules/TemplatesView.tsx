import { useState } from 'react'
import { useConductorSelector, shallowEqual, useActions } from '../../store'
import { buildTemplateCommand } from '../../core/state-lib'
import type { AgentTemplate, TemplateApproval, TemplateMode } from '../../core/types'
import { EditableName, IC, Icon, Switch, ViewHeader } from '../../components/ui'

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: "'JetBrains Mono', monospace",
} as const

const APPROVALS: Array<{ id: TemplateApproval; label: string; hint: string }> = [
  { id: 'safe', label: 'Safe — ask / read-only', hint: 'claude: default permission prompts · codex: --sandbox read-only' },
  { id: 'edits', label: 'Auto-approve edits', hint: 'claude: --permission-mode acceptEdits · codex: --sandbox workspace-write' },
  { id: 'full', label: 'Full access — no approvals', hint: 'claude: --dangerously-skip-permissions · codex: --dangerously-bypass-approvals-and-sandbox' },
]

/** Pair a template editor control with its label and optional hint. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.3 }}>{label}</span>
        {hint && <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** Full-view editor for one template — opened by create / edit */
/** Edit every persisted launch option for one agent template. */
function TemplateEditor({ tpl, onClose }: { tpl: AgentTemplate; onClose: () => void }) {
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes }), shallowEqual)
  const { updateTemplate, runTemplate } = useActions()
  const type = s.agentTypes.find(t => t.id === tpl.typeId)
  const preview = buildTemplateCommand(tpl, type, tpl.prompt.includes('{task}') ? '<task>' : undefined)
  // Scope every editor patch to the currently open template.
  const upd = (patch: Partial<AgentTemplate>) => updateTemplate(tpl.id, patch)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '7vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 640, maxWidth: '94vw', maxHeight: '84vh', overflowY: 'auto', background: 'var(--panel2)',
          border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <span className="mono" style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 5,
            color: tpl.mode === 'ephemeral' ? 'var(--accent)' : 'var(--green)',
            border: `1px solid ${tpl.mode === 'ephemeral' ? 'rgba(245,196,81,.4)' : 'rgba(61,220,151,.4)'}`,
          }}>
            {tpl.mode === 'ephemeral' ? 'ONE-SHOT' : 'INTERACTIVE'}
          </span>
          <EditableName name={tpl.name} onRename={name => upd({ name })} fontSize={15} />
          <div style={{ flex: 1 }} />
          <button className="open-btn" style={{ flex: 'none', padding: '5px 14px', fontSize: 12 }} onClick={() => { runTemplate(tpl.id); onClose() }}>
            ▶ Run now
          </button>
          <button className="icon-btn" title="Close" style={{ width: 28, height: 28, borderRadius: 7 }} onClick={onClose}>
            <Icon paths={IC.close} size={13} stroke={1.8} />
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 18, lineHeight: 1.5 }}>
          Changes save as you type.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="AGENT TYPE" hint="binary + env vars">
              <select value={tpl.typeId} onChange={e => upd({ typeId: e.target.value })} className="select-field" style={FIELD_STYLE}>
                {s.agentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="MODE">
              <select value={tpl.mode} onChange={e => upd({ mode: e.target.value as TemplateMode })} className="select-field" style={FIELD_STYLE} title="Ephemeral runs one task and exits by itself (claude -p / codex exec)">
                <option value="ephemeral">One-shot — run task & exit</option>
                <option value="interactive">Interactive — stays open</option>
              </select>
            </Field>
            <Field label="APPROVALS" hint={APPROVALS.find(a => a.id === tpl.approval)?.hint}>
              <select value={tpl.approval} onChange={e => upd({ approval: e.target.value as TemplateApproval })} className="select-field" style={FIELD_STYLE}>
                {APPROVALS.map(a => <option key={a.id} value={a.id} title={a.hint}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="MODEL" hint="passed as --model / -m">
              <input value={tpl.model} onChange={e => upd({ model: e.target.value })} placeholder="CLI default" style={FIELD_STYLE} />
            </Field>
          </div>

          <Field label="PROMPT" hint="{task} is replaced with the task text">
            <textarea
              value={tpl.prompt}
              onChange={e => upd({ prompt: e.target.value })}
              placeholder="what should the agent do?"
              rows={4}
              style={{ ...FIELD_STYLE, resize: 'vertical', lineHeight: 1.55 }}
            />
          </Field>

          <Field label="SYSTEM PROMPT" hint="optional · claude: --append-system-prompt; others: prepended to the prompt">
            <textarea
              value={tpl.systemPrompt}
              onChange={e => upd({ systemPrompt: e.target.value })}
              placeholder="persona, constraints, house rules…"
              rows={3}
              style={{ ...FIELD_STYLE, resize: 'vertical', lineHeight: 1.55 }}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="WORKING DIRECTORY">
              <input value={tpl.cwd} onChange={e => upd({ cwd: e.target.value })} placeholder="session default" style={FIELD_STYLE} />
            </Field>
            <Field label="EXTRA CLI FLAGS" hint="verbatim">
              <input value={tpl.extraArgs} onChange={e => upd({ extraArgs: e.target.value })} placeholder="e.g. --verbose" style={FIELD_STYLE} />
            </Field>
          </div>

          {tpl.mode === 'ephemeral' && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
            }}>
              <div style={{ flex: 1, fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
                <b style={{ color: 'var(--text)' }}>Auto-archive after a successful run</b><br />
                <span style={{ color: 'var(--dim)' }}>tidies the tab away once the monitor has summarized it</span>
              </div>
              <Switch on={tpl.autoArchive} onToggle={() => upd({ autoArchive: !tpl.autoArchive })} />
            </div>
          )}

          <Field label="COMMAND PREVIEW" hint="what this template launches">
            <div className="mono" style={{
              fontSize: 11, color: 'var(--dim)', background: '#07080B', border: '1px solid var(--line)',
              borderRadius: 9, padding: '10px 12px', whiteSpace: 'nowrap', overflowX: 'auto',
            }}>
              $ {preview}
            </div>
          </Field>
        </div>

        <div style={{ display: 'flex', marginTop: 20 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 10 }} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/** compact card — summary only; click to open the full editor */
/** Summarize a template and expose run, edit, and delete actions. */
function TemplateCard({ tpl, onEdit }: { tpl: AgentTemplate; onEdit: () => void }) {
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes }), shallowEqual)
  const { deleteTemplate, runTemplate } = useActions()
  const type = s.agentTypes.find(t => t.id === tpl.typeId)
  const promptPreview = tpl.prompt.replace(/\s+/g, ' ').trim()

  return (
    <div
      onClick={onEdit}
      className="palette-item"
      style={{
        background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '13px 15px',
        display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="mono" style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 5, flexShrink: 0,
          color: tpl.mode === 'ephemeral' ? 'var(--accent)' : 'var(--green)',
          border: `1px solid ${tpl.mode === 'ephemeral' ? 'rgba(245,196,81,.4)' : 'rgba(61,220,151,.4)'}`,
        }}>
          {tpl.mode === 'ephemeral' ? 'ONE-SHOT' : 'INTERACTIVE'}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tpl.name}</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', padding: '3px 12px', fontSize: 11.5 }} onClick={e => { e.stopPropagation(); runTemplate(tpl.id) }}>
          ▶ Run
        </button>
        <button className="icon-btn" title="Edit template" style={{ width: 24, height: 24, borderRadius: 6 }} onClick={e => { e.stopPropagation(); onEdit() }}>
          <Icon paths={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z']} size={12} stroke={1.8} />
        </button>
        <button className="icon-btn danger" title="Delete template" style={{ width: 24, height: 24, borderRadius: 6 }} onClick={e => { e.stopPropagation(); deleteTemplate(tpl.id) }}>
          <Icon paths={IC.close} size={11} stroke={2} />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--dim)' }}>
        <span className="mono">{type?.name ?? tpl.typeId}</span>
        {tpl.model && <><span style={{ color: 'var(--faint)' }}>·</span><span className="mono">{tpl.model}</span></>}
        <span style={{ color: 'var(--faint)' }}>·</span>
        <span>{APPROVALS.find(a => a.id === tpl.approval)?.label}</span>
      </div>
      {promptPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          “{promptPreview.slice(0, 110)}”
        </div>
      )}
    </div>
  )
}

/** Manage global reusable agent launch templates. */
export function TemplatesView() {
  const s = useConductorSelector(x => ({ templates: x.templates }), shallowEqual)
  const { addTemplate } = useActions()
  const [editingId, setEditingId] = useState<string | null>(null)
  const templates = s.templates ?? []
  const editing = editingId ? templates.find(t => t.id === editingId) : undefined

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Agent templates">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Preconfigured launches — one-shot or interactive</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setEditingId(addTemplate())}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New template
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 980 }}>
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginBottom: 16, lineHeight: 1.55, maxWidth: 720 }}>
            A template is a reusable launch config: CLI, model, approvals, prompts, and working folder.
            <b style={{ color: 'var(--text)' }}> One-shot</b> templates (claude -p, codex exec) run their task and exit by
            themselves; <b style={{ color: 'var(--text)' }}>interactive</b> ones stay open. Launch them anywhere a session
            starts — the new-session dialog, board tasks, schedules, or by asking Master. Click a template to edit it.
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))' }}>
            {templates.map(t => <TemplateCard key={t.id} tpl={t} onEdit={() => setEditingId(t.id)} />)}
            {templates.length === 0 && (
              <div style={{ padding: '30px 0', fontSize: 12.5, color: 'var(--dim)' }}>
                No templates yet — create one, or ask Master to build one.
              </div>
            )}
          </div>
        </div>
      </div>
      {editing && <TemplateEditor tpl={editing} onClose={() => setEditingId(null)} />}
    </div>
  )
}
