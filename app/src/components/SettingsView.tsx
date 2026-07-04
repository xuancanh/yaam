import { useState } from 'react'
import { useActions, useConductor } from '../store'
import { hexToRgba } from '../data'
import { pickFolder } from '../native'
import { PROVIDERS, providerFor } from '../master'
import { SHELLS } from '../data'
import { EditableName, IC, Icon, Switch, ViewHeader } from './ui'
import { ToolsSection } from './ToolsView'

const FIELD_STYLE = {
  background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: "'JetBrains Mono', monospace",
} as const

/** MCP servers chat agents can call tools on (streamable HTTP). */
function McpSection() {
  const s = useConductor()
  const { addMcpServer, updateMcpServer, removeMcpServer, connectMcpServer } = useActions()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState('')

  return (
    <>
      <SectionLabel>MCP SERVERS — tools for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.mcpServers.length === 0 && (
          <div style={{ padding: '14px 0', fontSize: 12, color: 'var(--dim)' }}>
            No MCP servers yet — add a streamable-HTTP endpoint below; its tools become available to every chat agent.
          </div>
        )}
        {s.mcpServers.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #1a1e26' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: m.lastError ? 'var(--red-soft)' : m.toolCount !== undefined ? 'var(--green)' : '#3a4150',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {m.name}
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 7 }}>
                  {m.lastError ? 'error' : m.toolCount !== undefined ? `${m.toolCount} tools` : 'not connected'}
                </span>
              </div>
              <div className="mono" title={m.lastError ?? m.url} style={{ fontSize: 10.5, color: m.lastError ? 'var(--red-soft)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.lastError ?? m.url}
              </div>
            </div>
            <button className="open-btn" style={{ flex: 'none', padding: '4px 11px', fontSize: 11.5 }} onClick={() => { void connectMcpServer(m.id) }}>
              {m.toolCount !== undefined ? 'Reconnect' : 'Connect'}
            </button>
            <Switch on={m.enabled} onToggle={() => updateMcpServer(m.id, { enabled: !m.enabled })} />
            <button className="icon-btn danger" title="Remove server" style={{ width: 26, height: 26 }} onClick={() => removeMcpServer(m.id)}>
              <Icon paths={IC.close} size={12} stroke={2} />
            </button>
          </div>
        ))}
        <div style={{ padding: '13px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="name" style={{ ...FIELD_STYLE, width: 140 }} />
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/mcp (streamable HTTP endpoint)" style={{ ...FIELD_STYLE, flex: 1 }} />
            <button
              className="open-btn"
              style={{ flex: 'none', padding: '6px 13px', fontSize: 12, opacity: url.trim() ? 1 : 0.5 }}
              disabled={!url.trim()}
              onClick={() => { addMcpServer(name, url, headers); setName(''); setUrl(''); setHeaders('') }}
            >
              Add & connect
            </button>
          </div>
          <textarea
            value={headers}
            onChange={e => setHeaders(e.target.value)}
            placeholder={'extra headers, one per line — e.g.\nAuthorization: Bearer sk-…'}
            rows={2}
            style={{ ...FIELD_STYLE, resize: 'vertical', fontSize: 11.5 }}
          />
        </div>
      </div>
    </>
  )
}

/** Skills registry: reusable instruction packs chat agents load on demand. */
function SkillsSection() {
  const s = useConductor()
  const { addSkill, updateSkill, removeSkill } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <>
      <SectionLabel>SKILLS — reusable instructions for chat agents</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skills.map(sk => (
          <div key={sk.id} style={{ padding: '11px 0', borderBottom: '1px solid #1a1e26' }}>
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
                  <input value={sk.name} onChange={e => updateSkill(sk.id, { name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} placeholder="name (agents load it by this)" style={{ ...FIELD_STYLE, width: 200 }} />
                  <input value={sk.description} onChange={e => updateSkill(sk.id, { description: e.target.value })} placeholder="one-line description — agents pick skills by this" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <textarea
                  value={sk.body}
                  onChange={e => updateSkill(sk.id, { body: e.target.value })}
                  placeholder="the instructions injected when a chat agent loads this skill"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", lineHeight: 1.5 }}
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
  const s = useConductor()
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
          <div key={pe.id} style={{ padding: '11px 0', borderBottom: '1px solid #1a1e26' }}>
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
                  <input value={pe.name} onChange={e => updatePersona(pe.id, { name: e.target.value.replace(/\s+/g, '-').toLowerCase() })} placeholder="name" style={{ ...FIELD_STYLE, width: 200 }} />
                  <input value={pe.description} onChange={e => updatePersona(pe.id, { description: e.target.value })} placeholder="one-line description (shown in the picker)" style={{ ...FIELD_STYLE, flex: 1 }} />
                </div>
                <textarea
                  value={pe.body}
                  onChange={e => updatePersona(pe.id, { body: e.target.value })}
                  placeholder="the persona instructions appended to the chat agent's system prompt"
                  rows={4}
                  style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", lineHeight: 1.5 }}
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
  const s = useConductor()
  const { addSkillRegistry, updateSkillRegistry, removeSkillRegistry, refreshSkillRegistry } = useActions()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  return (
    <>
      <SectionLabel>SKILL REGISTRIES — SKILL.md folders (GitHub tree URL or local path)</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skillRegistries.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #1a1e26' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: r.lastError ? 'var(--red-soft)' : r.skillCount !== undefined ? 'var(--green)' : '#3a4150',
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
  const s = useConductor()
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
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11, resize: 'vertical', minHeight: 30, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}
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

/** Render a consistent settings-section heading. */
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

/** Render global provider, orchestration, session, agent-type, and addon settings. */
const SETTINGS_TABS = [
  ['general', 'General'],
  ['brain', 'Master Brain'],
  ['types', 'Terminal Agents'],
  ['chatagents', 'Chat Agents'],
  ['mcp', 'MCP Servers'],
  ['tools', 'Tools & Permissions'],
] as const
type SettingsTab = (typeof SETTINGS_TABS)[number][0]

export function SettingsView() {
  const s = useConductor()
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

          </>}

          {tab === 'general' && <>
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
