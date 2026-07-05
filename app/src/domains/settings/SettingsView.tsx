import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
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
import { AppearanceSection } from './AppearanceSection'
import { SkillsSection, PersonasSection, SkillRegistriesSection, ChatTypesSection, AddChatTypeButton } from './ChatAgentSections'
import { confirmAction } from '../../components/Confirm'

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
  const s = useConductorSelector(x => ({ settings: x.settings, agentTypes: x.agentTypes, remoteInfo: x.remoteInfo }), shallowEqual)
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
            <div style={{ display: 'flex', gap: 14, padding: '14px 0', borderTop: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Phone remote</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Serve the mobile companion app on your network: work with tasks, chats, and sessions from your phone. Every device must be paired — connecting needs the link's token AND an explicit approval on this desktop. Commands run through the same action paths as the UI; execution and credentials never leave this machine. Works over Tailscale/WireGuard (each interface gets its own link) and behind a Cloudflare Tunnel via the public URL below.
                </div>
                {s.settings.remoteEnabled && s.remoteInfo && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(s.settings.remotePublicUrl?.trim()
                      ? [{ label: 'public', url: `${s.settings.remotePublicUrl.trim().replace(/\/+$/, '')}/?t=${s.remoteInfo.token}` }]
                      : []
                    ).concat(s.remoteInfo.urls ?? []).map(u => (
                      <div key={u.url} className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                        <span style={{ color: 'var(--dim)', textTransform: 'uppercase', fontSize: 9.5, fontWeight: 700, marginRight: 6 }}>{u.label}</span>
                        <span style={{ color: 'var(--accent)', userSelect: 'all' }}>{u.url}</span>
                      </div>
                    ))}
                  </div>
                )}
                {s.settings.remoteEnabled && (
                  <input
                    defaultValue={s.settings.remotePublicUrl ?? ''}
                    placeholder="Public base URL (Cloudflare Tunnel / MagicDNS) — optional"
                    onBlur={e => updateSettings({ remotePublicUrl: e.target.value.trim() })}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 8 }}
                  />
                )}
                {s.settings.remoteEnabled && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <input
                      key={s.settings.remoteToken ?? ''}
                      className="mono"
                      defaultValue={s.settings.remoteToken ?? ''}
                      placeholder="URL token"
                      disabled={s.settings.remoteTokenRotate === true}
                      title="The token carried in connect links. Persisted across restarts so links keep working; edit it to invalidate every existing link."
                      onBlur={e => { const v = e.target.value.trim(); if (v.length >= 8 && v !== s.settings.remoteToken) updateSettings({ remoteToken: v }) }}
                      style={{ ...FIELD_STYLE, flex: 1, opacity: s.settings.remoteTokenRotate ? 0.5 : 1 }}
                    />
                    <button
                      className="open-btn"
                      title="Mint a new token now — existing connect links stop working"
                      style={{ padding: '7px 11px', fontSize: 11.5, flexShrink: 0 }}
                      onClick={() => updateSettings({ remoteToken: Array.from(crypto.getRandomValues(new Uint8Array(24)), b => (b % 36).toString(36)).join('') })}
                    >
                      ↻ Regenerate
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--mut)', flexShrink: 0, cursor: 'pointer' }} title="Mint a fresh token on every app start (links must be re-copied each time)">
                      <input
                        type="checkbox"
                        checked={s.settings.remoteTokenRotate === true}
                        onChange={e => updateSettings({ remoteTokenRotate: e.target.checked })}
                      />
                      Auto-rotate
                    </label>
                  </div>
                )}
                {(s.settings.remoteDevices ?? []).length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(s.settings.remoteDevices ?? []).map(d => (
                      <span key={d.id} className="mono" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 99, border: '1px solid var(--line2)', color: 'var(--text2)' }}>
                        📱 {d.name || d.id.slice(0, 8)}
                        <button
                          title="Revoke this device — it must pair again to reconnect"
                          onClick={() => updateSettings({ remoteDevices: (s.settings.remoteDevices ?? []).filter(x => x.id !== d.id) })}
                          style={{ background: 'none', border: 'none', color: 'var(--red-soft)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <Switch
                on={s.settings.remoteEnabled === true}
                onToggle={() => updateSettings({ remoteEnabled: !s.settings.remoteEnabled })}
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
                        onClick={() => { void confirmAction({ title: `Delete agent type “${t.name.slice(0, 40)}”?`, detail: 'Sessions, templates, and tasks referencing it fall back to defaults. This cannot be undone.' }).then(ok => { if (ok) deleteAgentType(t.id) }) }}
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
