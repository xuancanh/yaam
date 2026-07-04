import { useConductor, useActions } from '../store'
import { buildTemplateCommand } from '../state-lib'
import type { AgentTemplate, TemplateApproval, TemplateMode } from '../types'
import { EditableName, IC, Icon, Switch, ViewHeader } from './ui'

const FIELD_STYLE = {
  background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: "'JetBrains Mono', monospace",
} as const

const APPROVALS: Array<{ id: TemplateApproval; label: string; hint: string }> = [
  { id: 'safe', label: 'Safe — ask / read-only', hint: 'claude: default permission prompts · codex: --sandbox read-only' },
  { id: 'edits', label: 'Auto-approve edits', hint: 'claude: --permission-mode acceptEdits · codex: --full-auto' },
  { id: 'full', label: 'Full access — no approvals', hint: 'claude: --dangerously-skip-permissions · codex: --dangerously-bypass-approvals-and-sandbox' },
]


function TemplateCard({ tpl }: { tpl: AgentTemplate }) {
  const s = useConductor()
  const { updateTemplate, deleteTemplate, runTemplate } = useActions()
  const type = s.agentTypes.find(t => t.id === tpl.typeId)
  const preview = buildTemplateCommand(tpl, type, tpl.prompt.includes('{task}') ? '<task>' : undefined)
  const upd = (patch: Partial<AgentTemplate>) => updateTemplate(tpl.id, patch)
  const row = { display: 'flex', gap: 8 } as const
  const half = { ...FIELD_STYLE, flex: 1, minWidth: 0, padding: '6px 9px', fontSize: 11.5 } as const

  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className="mono" style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '2px 8px', borderRadius: 5,
          color: tpl.mode === 'ephemeral' ? 'var(--accent)' : 'var(--green)',
          border: `1px solid ${tpl.mode === 'ephemeral' ? 'rgba(245,196,81,.4)' : 'rgba(61,220,151,.4)'}`,
        }}>
          {tpl.mode === 'ephemeral' ? 'ONE-SHOT' : 'INTERACTIVE'}
        </span>
        <EditableName name={tpl.name} onRename={name => upd({ name })} />
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', padding: '3px 12px', fontSize: 11.5 }} onClick={() => runTemplate(tpl.id)}>
          ▶ Run now
        </button>
        <button className="icon-btn danger" title="Delete template" style={{ width: 24, height: 24, borderRadius: 6 }} onClick={() => deleteTemplate(tpl.id)}>
          <Icon paths={IC.close} size={11} stroke={2} />
        </button>
      </div>
      <div style={row}>
        <select value={tpl.typeId} onChange={e => upd({ typeId: e.target.value })} className="select-field" style={half} title="Base agent type (binary + env vars)">
          {s.agentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={tpl.mode} onChange={e => upd({ mode: e.target.value as TemplateMode })} className="select-field" style={half} title="Ephemeral runs one task and exits by itself (claude -p / codex exec)">
          <option value="ephemeral">ephemeral — run task & exit</option>
          <option value="interactive">interactive — stays open</option>
        </select>
      </div>
      <div style={row}>
        <select
          value={tpl.approval}
          onChange={e => upd({ approval: e.target.value as TemplateApproval })}
          className="select-field"
          style={half}
          title={APPROVALS.find(a => a.id === tpl.approval)?.hint}
        >
          {APPROVALS.map(a => <option key={a.id} value={a.id} title={a.hint}>{a.label}</option>)}
        </select>
        <input value={tpl.model} onChange={e => upd({ model: e.target.value })} placeholder="model (CLI default)" style={half} title="Passed as --model / -m" />
      </div>
      <textarea
        value={tpl.prompt}
        onChange={e => upd({ prompt: e.target.value })}
        placeholder={'prompt · {task} is replaced with the task text'}
        rows={2}
        style={{ ...FIELD_STYLE, width: '100%', padding: '6px 9px', fontSize: 11.5, resize: 'vertical' }}
      />
      <textarea
        value={tpl.systemPrompt}
        onChange={e => upd({ systemPrompt: e.target.value })}
        placeholder="system prompt (optional) · claude: --append-system-prompt; others: prepended to the prompt"
        rows={2}
        style={{ ...FIELD_STYLE, width: '100%', padding: '6px 9px', fontSize: 11.5, resize: 'vertical' }}
      />
      <div style={row}>
        <input value={tpl.cwd} onChange={e => upd({ cwd: e.target.value })} placeholder="working directory (session default)" style={half} />
        <input value={tpl.extraArgs} onChange={e => upd({ extraArgs: e.target.value })} placeholder="extra CLI flags (verbatim)" style={half} />
      </div>
      <div className="mono" style={{
        fontSize: 10.5, color: 'var(--dim)', background: '#07080B', border: '1px solid var(--line)',
        borderRadius: 8, padding: '7px 10px', whiteSpace: 'nowrap', overflowX: 'auto',
      }} title="Command this template launches">
        $ {preview}
      </div>
      {tpl.mode === 'ephemeral' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 11.5, color: 'var(--mut)' }}>
            Auto-archive after a successful run <span style={{ color: 'var(--dim)' }}>— tidies the tab away once the monitor has summarized it</span>
          </div>
          <Switch on={tpl.autoArchive} onToggle={() => upd({ autoArchive: !tpl.autoArchive })} />
        </div>
      )}
    </div>
  )
}

export function TemplatesView() {
  const s = useConductor()
  const { addTemplate } = useActions()
  const templates = s.templates ?? []
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Agent templates">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Preconfigured launches — one-shot or interactive</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={addTemplate}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New template
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 980 }}>
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginBottom: 16, lineHeight: 1.55, maxWidth: 720 }}>
            A template is a reusable launch config. <b style={{ color: 'var(--text)' }}>One-shot</b> templates (claude -p, codex exec)
            spawn a session, run the task, and exit by themselves — ideal for scheduled and automated jobs.
            <b style={{ color: 'var(--text)' }}> Interactive</b> templates stay open. Launch them here, from the new-session dialog,
            a board task's schedule, a cron schedule, or by asking Master.
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}>
            {templates.map(t => <TemplateCard key={t.id} tpl={t} />)}
            {templates.length === 0 && (
              <div style={{ padding: '30px 0', fontSize: 12.5, color: 'var(--dim)' }}>
                No templates yet — create one, or ask Master to build one.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
