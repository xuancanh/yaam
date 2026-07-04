import { useActions, useConductor } from '../store'
import { hexToRgba } from '../data'
import { httpGetText, pickFolder } from '../native'
import { PROVIDERS, providerFor } from '../master'
import { buildTemplateCommand } from '../state-lib'
import type { AgentTemplate, TemplateApproval, TemplateMode } from '../types'
import { ALL_PERMISSIONS } from '../addons'
import { SHELLS } from '../data'
import { useState } from 'react'
import { EditableName, IC, Icon, Switch, ViewHeader } from './ui'

interface RegistryEntry {
  name: string
  version?: string
  icon?: string
  description?: string
  url: string
}

function AddonsSection() {
  const s = useConductor()
  const { toggleAddon, toggleAddonGrant, removeAddon, exportAddon, openAddon, installAddonFromFile, installAddonFromUrl, updateSettings } = useActions()
  const [url, setUrl] = useState('')
  const [registry, setRegistry] = useState<RegistryEntry[] | null>(null)
  const [regStatus, setRegStatus] = useState('')

  const browse = async () => {
    setRegStatus('loading…')
    try {
      const json = JSON.parse(await httpGetText(s.settings.registryUrl))
      const pkgs = Array.isArray(json.packages) ? json.packages as RegistryEntry[] : []
      setRegistry(pkgs)
      setRegStatus(pkgs.length ? '' : 'registry is empty')
    } catch (e) {
      setRegistry(null)
      setRegStatus(`failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const FIELD = { ...FIELD_STYLE, flex: 1 } as const

  return (
    <>
      <SectionLabel>ADDONS</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.addons.length === 0 && (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--dim)' }}>
            No addons yet — ask Master to build one, or install a package below.
          </div>
        )}
        {s.addons.map(a => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #1a1e26' }}>
            <span style={{ fontSize: 16, width: 22, textAlign: 'center' }}>{a.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {a.name}
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>v{a.version} · {a.source}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--mut)', marginTop: 1 }}>
                {[a.html ? 'view' : '', a.tools?.length ? `${a.tools.length} tool(s)` : '', a.hooks ? 'hooks' : ''].filter(Boolean).join(' · ') || 'empty'}
                {a.desc ? ` — ${a.desc}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                {a.permissions.map(perm => {
                  const on = a.granted.includes(perm)
                  const label = ALL_PERMISSIONS.find(x => x.id === perm)?.label ?? perm
                  return (
                    <button
                      key={perm}
                      title={`${label} — click to ${on ? 'revoke' : 'grant'}`}
                      onClick={() => toggleAddonGrant(a.id, perm)}
                      className="mono"
                      style={{
                        fontSize: 9.5, fontWeight: 600, padding: '2px 7px', borderRadius: 5,
                        border: '1px solid', cursor: 'pointer',
                        borderColor: on ? 'rgba(61,220,151,.35)' : 'var(--line2)',
                        background: on ? 'rgba(61,220,151,.1)' : 'transparent',
                        color: on ? 'var(--green)' : 'var(--dim)',
                        textDecoration: on ? 'none' : 'line-through',
                      }}
                    >
                      {perm}
                    </button>
                  )
                })}
              </div>
            </div>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => openAddon(a.id)}>Open</button>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => exportAddon(a.id)}>Export</button>
            <Switch on={a.enabled} onToggle={() => toggleAddon(a.id)} />
            <button className="icon-btn danger" title="Remove addon" style={{ width: 26, height: 26 }} onClick={() => removeAddon(a.id)}>
              <Icon paths={IC.close} size={12} stroke={2} />
            </button>
          </div>
        ))}
        <div style={{ padding: '13px 0', display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5 }}>
            ⚠ Addon tools and hooks run with app privileges — install packages only from sources you trust. Views stay sandboxed.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="open-btn" style={{ flex: 'none', padding: '6px 13px', fontSize: 12 }} onClick={installAddonFromFile}>
              Install from file…
            </button>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/addon.yaam.json" style={FIELD} />
            <button
              className="open-btn"
              style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: url.trim() ? 1 : 0.5 }}
              disabled={!url.trim()}
              onClick={() => { installAddonFromUrl(url.trim()); setUrl('') }}
            >
              Install URL
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={s.settings.registryUrl}
              onChange={e => updateSettings({ registryUrl: e.target.value })}
              placeholder="registry index URL"
              style={FIELD}
            />
            <button className="open-btn" style={{ flex: 'none', padding: '6px 13px', fontSize: 12 }} onClick={browse}>
              Browse registry
            </button>
          </div>
          {regStatus && <div className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{regStatus}</div>}
          {registry?.map(pkg => (
            <div key={pkg.url} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 9, padding: '9px 12px' }}>
              <span style={{ fontSize: 15 }}>{pkg.icon || '◆'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{pkg.name}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 6 }}>{pkg.version || ''}</span>
                <div style={{ fontSize: 11, color: 'var(--mut)' }}>{pkg.description || ''}</div>
              </div>
              <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={() => installAddonFromUrl(pkg.url)}>
                Install
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

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

function TemplatesSection() {
  const s = useConductor()
  const { addTemplate } = useActions()
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <SectionLabel>AGENT TEMPLATES</SectionLabel>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={addTemplate}>
          + Add template
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
        Preconfigured launches: one-shot templates (claude -p, codex exec) spawn, run their task, and exit by themselves;
        interactive ones stay open. Run them from here, the new-session dialog, a board task's schedule, a cron schedule, or ask Master.
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', marginBottom: 26 }}>
        {s.templates.map(t => <TemplateCard key={t.id} tpl={t} />)}
        {s.templates.length === 0 && (
          <div style={{ padding: '18px 0', fontSize: 12, color: 'var(--dim)' }}>No templates yet.</div>
        )}
      </div>
    </>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'var(--mut)', marginBottom: 11 }}>
      {children}
    </div>
  )
}

const ORCHESTRATION: Array<{ id: 'autoRoute' | 'approveDestructive' | 'followMode'; label: string; detail: string }> = [
  { id: 'autoRoute', label: 'Auto-route requests', detail: 'Master assigns tasks to the right agent without asking first.' },
  { id: 'approveDestructive', label: 'Require approval for destructive actions', detail: 'Migrations, file deletes, and deploys pause for your sign-off.' },
  { id: 'followMode', label: 'Follow mode', detail: 'Master watches every session and escalates when action is needed.' },
]

export function SettingsView() {
  const s = useConductor()
  const { toggleSetting, toggleAgentType, toggleIntegration, updateSettings, setAgentTypeCmd, updateAgentType, addAgentType, deleteAgentType } = useActions()

  const browseDefaultCwd = async () => {
    const dir = await pickFolder(s.settings.defaultCwd || undefined)
    if (dir) updateSettings({ defaultCwd: dir })
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Settings">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Agent types, integrations, and orchestration policy</span>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 820 }}>

          <SectionLabel>MASTER BRAIN</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>LLM Master</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Master is an LLM with tools — it routes tasks to sessions, launches and stops them, and builds schedules. Pick a provider and add credentials — an API key, or AWS Bedrock via your credential chain.
                </div>
              </div>
              <Switch on={s.settings.masterEnabled} onToggle={() => updateSettings({ masterEnabled: !s.settings.masterEnabled })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Provider</div>
              </div>
              <select
                value={s.settings.provider}
                onChange={e => {
                  const next = providerFor(e.target.value)
                  updateSettings({ provider: next.id, masterModel: next.models[0] ?? '' })
                }}
                style={{ ...FIELD_STYLE, width: 260 }}
              >
                {PROVIDERS.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
              </select>
            </div>
            {providerFor(s.settings.provider).id === 'bedrock' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS region</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Region hosting the Bedrock inference profile.</div>
                  </div>
                  <input
                    value={s.settings.awsRegion}
                    onChange={e => updateSettings({ awsRegion: e.target.value })}
                    placeholder="us-east-1"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS profile</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Profile from ~/.aws/config (SSO profiles auto-refresh their tokens). Empty = default credential chain: env vars, default profile, instance role.
                    </div>
                  </div>
                  <input
                    value={s.settings.awsProfile}
                    onChange={e => updateSettings({ awsProfile: e.target.value })}
                    placeholder="default"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional — overrides the profile. Any shell command that prints AWS credentials as JSON{' '}
                      (<span className="mono">aws configure export-credentials</span>,{' '}
                      <span className="mono">claude default-credential-export</span>) or{' '}
                      <span className="mono">AWS_*</span> env lines. Edit freely, including the binary path. Cached until the
                      credentials expire, then re-run automatically.
                    </div>
                  </div>
                  <input
                    value={s.settings.credCmd}
                    onChange={e => updateSettings({ credCmd: e.target.value })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential refresh command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional. Runs automatically when Bedrock rejects expired credentials, then the call retries — e.g. <span className="mono">aws sso login --profile work</span> or your corporate credential tool.
                    </div>
                  </div>
                  <input
                    value={s.settings.awsRefreshCmd}
                    onChange={e => updateSettings({ awsRefreshCmd: e.target.value })}
                    placeholder="aws sso login --profile …"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
            {providerFor(s.settings.provider).id === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Base URL</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>OpenAI-compatible endpoint root, e.g. http://localhost:11434/v1</div>
                </div>
                <input
                  value={s.settings.baseUrl}
                  onChange={e => updateSettings({ baseUrl: e.target.value })}
                  placeholder="https://…/v1"
                  style={{ ...FIELD_STYLE, width: 260 }}
                />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Type any model id — suggestions per provider.</div>
              </div>
              <input
                list="master-models"
                value={s.settings.masterModel}
                onChange={e => updateSettings({ masterModel: e.target.value })}
                placeholder="model id"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
              <datalist id="master-models">
                {providerFor(s.settings.provider).models.map(m => <option key={m} value={m} />)}
              </datalist>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Monitor model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Each session gets its own monitor LLM that watches output and only escalates digests to Master. Use a cheap model.
                </div>
              </div>
              <input
                list="master-models"
                value={s.settings.monitorModel}
                onChange={e => updateSettings({ monitorModel: e.target.value })}
                placeholder="same as Master model"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
            </div>
            {providerFor(s.settings.provider).id !== 'bedrock' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>API key</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Stored locally in the app data folder. Leave empty if you use a credential command below.</div>
                  </div>
                  <input
                    type="password"
                    value={s.settings.apiKey}
                    onChange={e => updateSettings({ apiKey: e.target.value })}
                    placeholder={providerFor(s.settings.provider).keyHint}
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional — overrides the API key. Any shell command that prints the credential (raw key/token or JSON), e.g.{' '}
                      <span className="mono">claude default-credential-export</span> — edit freely, including the binary path{' '}
                      (<span className="mono">~/.claude/local/claude …</span>) or flags. Runs in a login shell, is cached until the
                      credential expires, and re-runs automatically when the API rejects it, so short-lived tokens keep working.
                    </div>
                  </div>
                  <input
                    value={s.settings.credCmd}
                    onChange={e => updateSettings({ credCmd: e.target.value })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
          </div>

          <SectionLabel>SESSION DEFAULTS</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Terminal shell</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Used when launching a plain terminal session.</div>
              </div>
              <select
                value={s.settings.shell}
                onChange={e => updateSettings({ shell: e.target.value })}
                style={{ ...FIELD_STYLE, width: 160 }}
              >
                {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Default working directory</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Prefilled in the new-session dialog.</div>
              </div>
              <input
                value={s.settings.defaultCwd}
                onChange={e => updateSettings({ defaultCwd: e.target.value })}
                placeholder="none"
                style={{ ...FIELD_STYLE, width: 220 }}
              />
              <button className="open-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={browseDefaultCwd}>Browse…</button>
            </div>
          </div>

          <SectionLabel>ORCHESTRATION</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            {ORCHESTRATION.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid #1a1e26' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{o.detail}</div>
                </div>
                <Switch on={s.settings[o.id]} onToggle={() => toggleSetting(o.id)} />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
            <SectionLabel>AGENT TYPES</SectionLabel>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={addAgentType}>
              + Add agent type
            </button>
          </div>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 26 }}>
            {s.agentTypes.map(t => (
              <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', gap: 12 }}>
                <div className="mono" style={{
                  width: 38, height: 38, borderRadius: 10, background: hexToRgba(t.color, 0.14),
                  border: `1px solid ${hexToRgba(t.color, 0.4)}`, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, fontWeight: 600, color: t.color, flexShrink: 0,
                }}>
                  {t.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <EditableName name={t.name} onRename={name => updateAgentType(t.id, { name })} />
                    {t.custom && (
                      <button
                        className="icon-btn danger"
                        title="Delete agent type"
                        style={{ width: 22, height: 22, borderRadius: 6, marginLeft: 'auto' }}
                        onClick={() => deleteAgentType(t.id)}
                      >
                        <Icon paths={IC.close} size={11} stroke={2} />
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 4, lineHeight: 1.45 }}>{t.desc}</div>
                  <input
                    value={t.model}
                    onChange={e => setAgentTypeCmd(t.id, e.target.value)}
                    placeholder="launch command · e.g. claude"
                    title="Command used to launch this agent type"
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 8, padding: '5px 9px', fontSize: 11.5 }}
                  />
                  <textarea
                    value={t.env ?? ''}
                    onChange={e => updateAgentType(t.id, { env: e.target.value })}
                    placeholder={'environment · one per line\nANTHROPIC_MODEL=claude-sonnet-5\nHTTP_PROXY=…'}
                    rows={2}
                    title="Environment variables applied when launching this agent type"
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11, resize: 'vertical', minHeight: 34 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                    <span style={{ fontSize: 11, color: t.enabled ? 'var(--green)' : '#6B7280', fontWeight: 600 }}>
                      {t.enabled ? 'Enabled' : 'Disabled'} · {t.tools} tools
                    </span>
                    <Switch on={t.enabled} onToggle={() => toggleAgentType(t.id)} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <TemplatesSection />

          <AddonsSection />

          <SectionLabel>INTEGRATIONS</SectionLabel>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {s.integrations.map(g => (
              <div key={g.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="grotesk" style={{
                    width: 34, height: 34, borderRadius: 9, background: 'var(--panel3)', border: '1px solid var(--line2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#C7CCD6',
                  }}>
                    {g.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--dim)' }}>{g.cat}</div>
                  </div>
                  <Switch on={g.connected} onToggle={() => toggleIntegration(g.id)} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: g.connected ? 'var(--green)' : '#3a4150' }} />
                  <span style={{ fontSize: 11.5, color: g.connected ? 'var(--green)' : 'var(--dim)' }}>{g.detail}</span>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  )
}
