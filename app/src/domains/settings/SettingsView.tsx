import { useState } from 'react'
import type { ReactNode } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { APPEARANCE_DEFAULTS } from '../../app/appearance'
import type { AppearanceSettings } from '../../core/types'
import { hexToRgba } from '../../core/data'
import { pickFolder } from '../../core/native'
import { PROVIDERS, providerFor } from '../../master'
import { SHELLS } from '../../core/data'
import { EditableName, IC, Icon, Switch, ViewHeader } from '../../components/ui'
import { DraftInput, DraftTextarea } from '../../components/DraftInput'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { ToolsSection } from './ToolsView'
import { McpSection } from './McpSection'
import { PluginsSection } from './PluginsSection'

/** Skills registry: reusable instruction packs chat agents load on demand. */
function SkillsSection() {
  const s = useConductorSelector(x => ({ skills: x.skills }), shallowEqual)
  const { addSkill, updateSkill, removeSkill } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <>
      <SectionLabel>SKILLS — reusable instructions for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skills.map(sk => (
          <div key={sk.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setOpenId(openId === sk.id ? null : sk.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--dim)', fontSize: 10, width: 16, cursor: 'pointer' }}
              >
                {openId === sk.id ? '▾' : '▸'}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{sk.name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--mut)', marginLeft: 8 }}>{sk.description || 'no description'}</span>
              </div>
              <button className="icon-btn danger" title="Remove skill" style={{ width: 24, height: 24 }} onClick={() => removeSkill(sk.id)}>
                <Icon paths={IC.close} size={11} stroke={2} />
              </button>
            </div>
            {openId === sk.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 0 4px 26px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <DraftInput value={sk.name} onCommit={v => updateSkill(sk.id, { name: v.replace(/\s+/g, '-').toLowerCase() })} placeholder="name (agents load it by this)" style={{ ...FIELD_STYLE, width: 200 }} />
                  <DraftInput value={sk.description} onCommit={v => updateSkill(sk.id, { description: v })} placeholder="one-line description — agents pick skills by this" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <DraftTextarea
                  value={sk.body}
                  onCommit={v => updateSkill(sk.id, { body: v })}
                  placeholder="the instructions injected when a chat agent loads this skill"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.5 }}
                />
              </div>
            )}
          </div>
        ))}
        <div style={{ padding: '12px 0' }}>
          <button className="open-btn" style={{ flex: 'none', padding: '6px 13px', fontSize: 12 }} onClick={() => setOpenId(addSkill())}>
            New skill
          </button>
        </div>
      </div>
    </>
  )
}

/** Personas: named voices/roles a chat adopts (picked per chat). */
function PersonasSection() {
  const s = useConductorSelector(x => ({ personas: x.personas }), shallowEqual)
  const { addPersona, updatePersona, removePersona } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <SectionLabel>PERSONAS — pick one when starting a chat; appended to the agent's instructions</SectionLabel>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={() => setOpenId(addPersona())}>
          + New persona
        </button>
      </div>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.personas.length === 0 && (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--dim)' }}>No personas yet.</div>
        )}
        {s.personas.map(pe => (
          <div key={pe.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => setOpenId(openId === pe.id ? null : pe.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--dim)', fontSize: 10, width: 16, cursor: 'pointer' }}
              >
                {openId === pe.id ? '▾' : '▸'}
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{pe.name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--mut)', marginLeft: 8 }}>{pe.description || 'no description'}</span>
              </div>
              <button className="icon-btn danger" title="Remove persona" style={{ width: 24, height: 24 }} onClick={() => removePersona(pe.id)}>
                <Icon paths={IC.close} size={11} stroke={2} />
              </button>
            </div>
            {openId === pe.id && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '9px 0 4px 26px' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <DraftInput value={pe.name} onCommit={v => updatePersona(pe.id, { name: v.replace(/\s+/g, '-').toLowerCase() })} placeholder="name" style={{ ...FIELD_STYLE, width: 200 }} />
                  <DraftInput value={pe.description} onCommit={v => updatePersona(pe.id, { description: v })} placeholder="one-line description (shown in the picker)" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <DraftTextarea
                  value={pe.body}
                  onCommit={v => updatePersona(pe.id, { body: v })}
                  placeholder="the persona instructions appended to the chat agent's system prompt"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.5 }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** Skill registries: remote (github tree) or local-folder skill sources. */
function SkillRegistriesSection() {
  const s = useConductorSelector(x => ({ skillRegistries: x.skillRegistries }), shallowEqual)
  const { addSkillRegistry, updateSkillRegistry, removeSkillRegistry, refreshSkillRegistry } = useActions()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  return (
    <>
      <SectionLabel>SKILL REGISTRIES — SKILL.md folders (GitHub tree URL or local path)</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skillRegistries.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: r.lastError ? 'var(--red-soft)' : r.skillCount !== undefined ? 'var(--green)' : 'var(--line3)',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {r.name}
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>
                  {r.lastError ? 'error' : r.skillCount !== undefined ? `${r.skillCount} skills` : 'not fetched'}
                </span>
              </div>
              <div className="mono" title={r.lastError ?? r.url} style={{ fontSize: 10.5, color: r.lastError ? 'var(--red-soft)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.lastError ?? r.url}
              </div>
            </div>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => { void refreshSkillRegistry(r.id) }}>
              Refresh
            </button>
            <Switch on={r.enabled} onToggle={() => updateSkillRegistry(r.id, { enabled: !r.enabled })} />
            <button className="icon-btn danger" title="Remove registry" style={{ width: 26, height: 26 }} onClick={() => removeSkillRegistry(r.id)}>
              <Icon paths={IC.close} size={12} stroke={2} />
            </button>
          </div>
        ))}
        <div style={{ padding: '13px 0', display: 'flex', gap: 8 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="name" style={{ ...FIELD_STYLE, width: 140 }} />
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/o/r/tree/main/skills — or /local/folder" style={{ ...FIELD_STYLE, flex: 1 }} />
          <button
            className="open-btn"
            style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: url.trim() ? 1 : 0.5 }}
            disabled={!url.trim()}
            onClick={() => { addSkillRegistry(name, url); setName(''); setUrl('') }}
          >
            Add & fetch
          </button>
        </div>
      </div>
    </>
  )
}

/** Small header button that adds a chat-agent type (needs its own hook scope). */
function AddChatTypeButton() {
  const { addChatAgentType } = useActions()
  return (
    <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={addChatAgentType}>
      + Add chat agent
    </button>
  )
}

/** Configurable chat-agent types: provider, model, credentials, persona. */
function ChatTypesSection() {
  const s = useConductorSelector(x => ({ chatAgentTypes: x.chatAgentTypes, settings: x.settings }), shallowEqual)
  const { updateChatAgentType, deleteChatAgentType } = useActions()
  return (
    <>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', marginBottom: 26 }}>
        {s.chatAgentTypes.map(t => {
          const prov = providerFor(t.provider)
          const needsBase = prov.models.length === 0
          const sharesMaster = t.provider === s.settings.provider && !t.apiKey
          return (
            <div key={t.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 15, display: 'flex', gap: 12 }}>
              <div className="mono" style={{
                width: 38, height: 38, borderRadius: 10, background: hexToRgba('#7FD1FF', 0.14),
                border: '1px solid ' + hexToRgba('#7FD1FF', 0.4), display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#7FD1FF', flexShrink: 0,
              }}>
                {t.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <EditableName name={t.name} onRename={name => updateChatAgentType(t.id, { name })} />
                  <button
                    className="icon-btn danger"
                    title="Delete chat agent type"
                    style={{ width: 22, height: 22, borderRadius: 6, marginLeft: 'auto' }}
                    onClick={() => deleteChatAgentType(t.id)}
                  >
                    <Icon paths={IC.close} size={11} stroke={2} />
                  </button>
                </div>
                {t.desc && <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 4, lineHeight: 1.45 }}>{t.desc}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, minWidth: 0 }}>
                  <select
                    value={t.provider}
                    onChange={e => {
                      const next = providerFor(e.target.value)
                      updateChatAgentType(t.id, { provider: next.id, models: next.models.length ? next.models : [], model: next.models[0] ?? '' })
                    }}
                    className="select-field"
                    style={{ ...FIELD_STYLE, flex: 1, minWidth: 0, padding: '5px 9px', fontSize: 11.5 }}
                  >
                    {PROVIDERS.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
                  </select>
                  {prov.models.length > 0 && (
                    <button
                      className="open-btn"
                      title="Fill the model list with this provider's known models"
                      style={{ flex: 'none', padding: '0 10px', fontSize: 10.5 }}
                      onClick={() => updateChatAgentType(t.id, { models: prov.models, model: prov.models[0] })}
                    >
                      defaults
                    </button>
                  )}
                </div>
                <textarea
                  value={(t.models ?? (t.model ? [t.model] : [])).join('\n')}
                  onChange={e => {
                    const models = e.target.value.split('\n').map(x => x.trim())
                    updateChatAgentType(t.id, { models, model: models.find(Boolean) ?? '' })
                  }}
                  placeholder={'models — one per line, first is the default\n' + (prov.models[0] ?? 'model-id')}
                  rows={Math.min(5, Math.max(2, (t.models?.length ?? 1) + 1))}
                  title="Pickable per session in the new-session dialog; the first line is the default"
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5, resize: 'vertical', minHeight: 34 }}
                />
                {t.provider !== 'bedrock' && (
                  <input
                    type="password"
                    value={t.apiKey ?? ''}
                    onChange={e => updateChatAgentType(t.id, { apiKey: e.target.value || undefined })}
                    placeholder={sharesMaster ? 'API key (empty = share Master Brain credentials)' : 'API key · ' + prov.keyHint}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                {needsBase && (
                  <input
                    value={t.baseUrl ?? ''}
                    onChange={e => updateChatAgentType(t.id, { baseUrl: e.target.value || undefined })}
                    placeholder={prov.protocol === 'anthropic' ? 'base URL · https://…  (Anthropic-compatible /v1/messages)' : 'base URL · https://…/v1  (OpenAI-compatible)'}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                <textarea
                  value={t.systemPrompt ?? ''}
                  onChange={e => updateChatAgentType(t.id, { systemPrompt: e.target.value || undefined })}
                  placeholder="persona (optional) · appended to the agent's system prompt"
                  rows={2}
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11, resize: 'vertical', minHeight: 30, fontFamily: 'var(--font-sans)' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                  <span style={{ fontSize: 11, color: t.enabled ? 'var(--green)' : '#6B7280', fontWeight: 600 }}>
                    {t.enabled ? 'Enabled' : 'Disabled'}{t.provider === 'bedrock' ? ' · AWS chain' : t.apiKey ? ' · own key' : sharesMaster ? ' · shares Master creds' : ' · no credentials'}
                  </span>
                  <Switch on={t.enabled} onToggle={() => updateChatAgentType(t.id, { enabled: !t.enabled })} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/** One labeled appearance row with the control on the right. */
function AppearanceRow({ label, detail, children, last }: { label: string; detail: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0', borderBottom: last ? 'none' : '1px solid var(--line-soft)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{detail}</div>
      </div>
      {children}
    </div>
  )
}

/** Theme, UI scale, density, and typography (Settings → General). */
function AppearanceSection() {
  const s = useConductorSelector(x => ({ appearance: x.settings.appearance }), shallowEqual)
  const { updateSettings } = useActions()
  const a = { ...APPEARANCE_DEFAULTS, ...s.appearance }
  const patch = (p: AppearanceSettings) => updateSettings({ appearance: { ...s.appearance, ...p } })
  return (
    <>
      <SectionLabel>APPEARANCE</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <AppearanceRow label="Theme" detail="Color palette for the whole app; System follows the OS light/dark setting.">
          <select value={a.theme} onChange={e => patch({ theme: e.target.value as AppearanceSettings['theme'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="dark">Dark</option>
            <option value="midnight">Midnight</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface scale" detail="Scales all text and spacing together.">
          <input
            type="range" min={80} max={140} step={5}
            value={a.uiScale}
            onChange={e => patch({ uiScale: Number(e.target.value) })}
            style={{ width: 150 }}
          />
          <span className="mono" style={{ fontSize: 12, width: 44, textAlign: 'right' }}>{a.uiScale}%</span>
        </AppearanceRow>
        <AppearanceRow label="Density" detail="Row spacing and message padding in chats and lists.">
          <select value={a.density} onChange={e => patch({ density: e.target.value as AppearanceSettings['density'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface font" detail="The sans-serif face used across the app.">
          <select value={a.uiFont} onChange={e => patch({ uiFont: e.target.value as AppearanceSettings['uiFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="plex">IBM Plex Sans</option>
            <option value="system">System</option>
            <option value="grotesk">Space Grotesk</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Monospace font" detail="Code, paths, terminals-adjacent labels.">
          <select value={a.monoFont} onChange={e => patch({ monoFont: e.target.value as AppearanceSettings['monoFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="jetbrains">JetBrains Mono</option>
            <option value="system">System mono</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Table typography" detail="Font size and family for markdown tables in chat replies." last>
          <input
            type="number" min={10} max={20}
            value={a.tableFontSize}
            onChange={e => patch({ tableFontSize: Math.max(10, Math.min(20, Number(e.target.value) || 13)) })}
            style={{ ...FIELD_STYLE, width: 64 }}
          />
          <select value={a.tableFont} onChange={e => patch({ tableFont: e.target.value as AppearanceSettings['tableFont'] })} style={{ ...FIELD_STYLE, width: 120 }}>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
        </AppearanceRow>
      </div>
    </>
  )
}

const ORCHESTRATION: Array<{ id: 'autoRoute' | 'approveDestructive' | 'followMode'; label: string; detail: string }> = [
  { id: 'autoRoute', label: 'Auto-route requests', detail: 'Master assigns tasks to the right agent without asking first.' },
  { id: 'approveDestructive', label: 'Require approval for destructive actions', detail: 'Migrations, file deletes, and deploys pause for your sign-off.' },
  { id: 'followMode', label: 'Follow mode', detail: 'Master watches every session and escalates when action is needed.' },
]

/** Render global provider, orchestration, session, agent-type, and addon settings. */
const SETTINGS_TABS = [
  ['general', 'General'],
  ['appearance', 'Appearance'],
  ['brain', 'Master Brain'],
  ['types', 'Terminal Agents'],
  ['chatagents', 'Chat Agents'],
  ['mcp', 'MCP Servers'],
  ['tools', 'Tools & Permissions'],
] as const
type SettingsTab = (typeof SETTINGS_TABS)[number][0]

export function SettingsView() {
  const s = useConductorSelector(x => ({ settings: x.settings, agentTypes: x.agentTypes }), shallowEqual)
  const { toggleSetting, toggleAgentType, updateSettings, setAgentTypeCmd, updateAgentType, addAgentType, deleteAgentType } = useActions()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [chatTab, setChatTab] = useState<'agents' | 'personas' | 'skills'>('agents')

  // Fill the default working directory from the native folder picker.
  const browseDefaultCwd = async () => {
    const dir = await pickFolder(s.settings.defaultCwd || undefined)
    if (dir) updateSettings({ defaultCwd: dir })
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Settings">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Agent types, MCP servers, skills, and orchestration policy</span>
      </ViewHeader>
      <div style={{
        display: 'flex', gap: 4, padding: '10px 22px 0', borderBottom: '1px solid var(--line)',
        background: 'var(--panel)', flexShrink: 0,
      }}>
        {SETTINGS_TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              background: 'transparent', border: 'none', padding: '8px 14px 10px', fontSize: 12.5,
              fontWeight: 600, cursor: 'pointer',
              color: tab === id ? 'var(--accent)' : 'var(--mut)',
              borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 820 }}>

          {tab === 'brain' && <>
          <SectionLabel>MASTER BRAIN</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>LLM Master</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Master is an LLM with tools — it routes tasks to sessions, launches and stops them, and builds schedules. Pick a provider and add credentials — an API key, or AWS Bedrock via your credential chain.
                </div>
              </div>
              <Switch on={s.settings.masterEnabled} onToggle={() => updateSettings({ masterEnabled: !s.settings.masterEnabled })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS region</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Region hosting the Bedrock inference profile.</div>
                  </div>
                  <DraftInput
                    value={s.settings.awsRegion}
                    onCommit={v => updateSettings({ awsRegion: v })}
                    placeholder="us-east-1"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>AWS profile</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Profile from ~/.aws/config (SSO profiles auto-refresh their tokens). Empty = default credential chain: env vars, default profile, instance role.
                    </div>
                  </div>
                  <DraftInput
                    value={s.settings.awsProfile}
                    onCommit={v => updateSettings({ awsProfile: v })}
                    placeholder="default"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
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
                  <DraftInput
                    value={s.settings.credCmd}
                    onCommit={v => updateSettings({ credCmd: v })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>Credential refresh command</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                      Optional. Runs automatically when Bedrock rejects expired credentials, then the call retries — e.g. <span className="mono">aws sso login --profile work</span> or your corporate credential tool.
                    </div>
                  </div>
                  <DraftInput
                    value={s.settings.awsRefreshCmd}
                    onCommit={v => updateSettings({ awsRefreshCmd: v })}
                    placeholder="aws sso login --profile …"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
            {providerFor(s.settings.provider).id === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Base URL</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>OpenAI-compatible endpoint root, e.g. http://localhost:11434/v1</div>
                </div>
                <DraftInput
                  value={s.settings.baseUrl}
                  onCommit={v => updateSettings({ baseUrl: v })}
                  placeholder="https://…/v1"
                  style={{ ...FIELD_STYLE, width: 260 }}
                />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Type any model id — suggestions per provider.</div>
              </div>
              <DraftInput
                list="master-models"
                value={s.settings.masterModel}
                onCommit={v => updateSettings({ masterModel: v })}
                placeholder="model id"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
              <datalist id="master-models">
                {providerFor(s.settings.provider).models.map(m => <option key={m} value={m} />)}
              </datalist>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Monitor model</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Each session gets its own monitor LLM that watches output and only escalates digests to Master. Use a cheap model.
                </div>
              </div>
              <DraftInput
                list="master-models"
                value={s.settings.monitorModel}
                onCommit={v => updateSettings({ monitorModel: v })}
                placeholder="same as Master model"
                style={{ ...FIELD_STYLE, width: 260 }}
              />
            </div>
            {providerFor(s.settings.provider).id !== 'bedrock' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>API key</div>
                    <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Stored locally in the app data folder. Leave empty if you use a credential command below.</div>
                  </div>
                  <DraftInput
                    type="password"
                    value={s.settings.apiKey}
                    onCommit={v => updateSettings({ apiKey: v })}
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
                  <DraftInput
                    value={s.settings.credCmd}
                    onCommit={v => updateSettings({ credCmd: v })}
                    placeholder="claude default-credential-export"
                    style={{ ...FIELD_STYLE, width: 260 }}
                  />
                </div>
              </>
            )}
          </div>

          </>}

          {tab === 'appearance' && <AppearanceSection />}

          {tab === 'general' && <>
          <SectionLabel>SESSION DEFAULTS</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
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
              <DraftInput
                value={s.settings.defaultCwd}
                onCommit={v => updateSettings({ defaultCwd: v })}
                placeholder="none"
                style={{ ...FIELD_STYLE, width: 220 }}
              />
              <button className="open-btn" style={{ flex: 'none', padding: '7px 12px' }} onClick={browseDefaultCwd}>Browse…</button>
            </div>
          </div>

          <SectionLabel>ORCHESTRATION</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            {ORCHESTRATION.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{o.detail}</div>
                </div>
                <Switch on={s.settings[o.id]} onToggle={() => toggleSetting(o.id)} />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Desktop notifications</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Escalations and finished work reach the OS notification center while YAAM is in the background.</div>
              </div>
              <Switch
                on={s.settings.osNotifications !== false}
                onToggle={() => updateSettings({ osNotifications: s.settings.osNotifications === false })}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>GitHub token</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Personal access token for skill registries, plugin marketplaces, and MCP catalogs — lifts the 60 req/h unauthenticated API limit. Stored in the OS keychain.
                </div>
              </div>
              <input
                type="password"
                defaultValue={s.settings.githubToken ?? ''}
                placeholder="ghp_… / github_pat_…"
                onBlur={e => updateSettings({ githubToken: e.target.value.trim() })}
                style={{ ...FIELD_STYLE, width: 240 }}
              />
            </div>
          </div>

          </>}

          {tab === 'types' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
            <SectionLabel>TERMINAL AGENTS — external CLIs in PTY sessions</SectionLabel>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={addAgentType}>+ Add terminal agent</button>
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
                  <DraftInput
                    value={t.model}
                    onCommit={v => setAgentTypeCmd(t.id, v)}
                    placeholder="launch command · e.g. claude"
                    title="Command used to launch this agent type"
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 8, padding: '5px 9px', fontSize: 11.5 }}
                  />
                  <DraftTextarea
                    value={t.env ?? ''}
                    onCommit={v => updateAgentType(t.id, { env: v })}
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
          </>}

          {tab === 'chatagents' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 9, padding: 3 }}>
              {([['agents', 'Agents'], ['personas', 'Personas'], ['skills', 'Skills']] as const).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setChatTab(id)}
                  style={{
                    border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: chatTab === id ? 'rgba(245,196,81,.14)' : 'transparent',
                    color: chatTab === id ? 'var(--accent)' : 'var(--mut)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {chatTab === 'agents' && <AddChatTypeButton />}
          </div>
          {chatTab === 'agents' && <>
            <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 12, lineHeight: 1.5 }}>
              Each chat agent picks a provider, a model list (pickable per chat), credentials, and an optional base persona. Empty API key = share the Master Brain credentials when the provider matches.
            </div>
            <ChatTypesSection />
          </>}
          {chatTab === 'personas' && <PersonasSection />}
          {chatTab === 'skills' && <>
            <PluginsSection />
            <SkillRegistriesSection />
            <SkillsSection />
          </>}
          </>}

          {tab === 'mcp' && <McpSection />}

          {tab === 'tools' && <>
          <SectionLabel>MASTER TOOLS — what Master may do; click a permission to cycle it</SectionLabel>
          <ToolsSection />
          </>}

        </div>
      </div>
    </div>
  )
}
