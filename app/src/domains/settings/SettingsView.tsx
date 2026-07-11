import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { pickFolder } from '../../core/native'
import { PROVIDERS, providerFor } from '../../master'
import { SHELLS } from '../../core/data'
import { Icon, Switch, ViewHeader } from '../../components/ui'
import { DraftInput } from '../../components/DraftInput'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'

/** One connect link with a copy button (transient ✓ feedback). */
function ConnectLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mono" style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11.5, wordBreak: 'break-all' }}>
      <span style={{ color: 'var(--dim)', textTransform: 'uppercase', fontSize: 9.5, fontWeight: 700, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--accent)', userSelect: 'all', flex: 1, minWidth: 0 }}>{url}</span>
      <button
        className="icon-btn"
        title="Copy link"
        style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0, alignSelf: 'center', color: copied ? 'var(--green)' : undefined }}
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          })
        }}
      >
        {copied
          ? <Icon paths={['M5 13l4 4L19 7']} size={12} stroke={2} />
          : <Icon paths={['M9 9h10v10H9z', 'M5 15V5h10']} size={12} stroke={1.7} />}
      </button>
    </div>
  )
}
import { ToolsSection } from './ToolsView'
import { McpSection } from './McpSection'
import { MachinesSection } from './MachinesSection'
import { TerminalAgentsSection } from './TerminalAgentsSection'
import { BrainProfilesBar } from './BrainProfiles'
import { PluginsSection } from './PluginsSection'
import { AppearanceSection } from './AppearanceSection'
import { AssistantsSection } from './AssistantsSection'
import { SkillsSection, SkillRegistriesSection, ChatTypesSection, AddChatTypeButton } from './ChatAgentSections'

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
  ['assistants', 'Assistants'],
  ['types', 'Terminal Agents'],
  ['chatagents', 'Chat Agents'],
  ['mcp', 'MCP Servers'],
  ['machines', 'Machines'],
  ['remote', 'Remote Control'],
  ['tools', 'Tools & Permissions'],
] as const
type SettingsTab = (typeof SETTINGS_TABS)[number][0]

export function SettingsView() {
  const s = useConductorSelector(x => ({ settings: x.settings, remoteInfo: x.remoteInfo }), shallowEqual)
  const { toggleSetting, updateSettings } = useActions()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [chatTab, setChatTab] = useState<'agents' | 'skills'>('agents')
  const [openChatTypeId, setOpenChatTypeId] = useState<string | null>(null)

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
          <BrainProfilesBar />
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

          {tab === 'assistants' && <AssistantsSection />}

          {tab === 'general' && <>
          <SectionLabel>SESSION DEFAULTS</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Terminal shell</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>Used for plain terminals and to run session commands with your normal login environment.</div>
              </div>
              <select
                value={s.settings.shell}
                onChange={e => updateSettings({ shell: e.target.value })}
                style={{ ...FIELD_STYLE, width: 160 }}
              >
                {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Chat auto-compact</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>When one turn's context reaches this many thousand tokens, the conversation is distilled into a summary (the transcript stays; /compact runs it manually). 0 disables.</div>
              </div>
              <DraftInput
                value={String((s.settings.chatCompactTokens ?? 80_000) / 1000)}
                onCommit={v => {
                  const n = Number(v)
                  if (Number.isFinite(n) && n >= 0) updateSettings({ chatCompactTokens: Math.round(n) * 1000 })
                }}
                placeholder="80"
                style={{ ...FIELD_STYLE, width: 90 }}
              />
              <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>k tokens</span>
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

          {tab === 'types' && <TerminalAgentsSection />}

          {tab === 'chatagents' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 4, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 9, padding: 3 }}>
              {([['agents', 'Agents'], ['skills', 'Skills']] as const).map(([id, label]) => (
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
            {chatTab === 'agents' && <AddChatTypeButton onAdded={setOpenChatTypeId} />}
          </div>
          {chatTab === 'agents' && <>
            <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 12, lineHeight: 1.5 }}>
              Each chat agent picks a provider, a model list (pickable per chat), credentials, and optional base instructions. Empty API key = share the Master Brain credentials when the provider matches. Click an agent to configure it.
            </div>
            <ChatTypesSection openId={openChatTypeId} setOpenId={setOpenChatTypeId} />
          </>}
          {chatTab === 'skills' && <>
            <PluginsSection />
            <SkillRegistriesSection />
            <SkillsSection />
          </>}
          </>}

          {tab === 'mcp' && <McpSection />}
          {tab === 'machines' && <MachinesSection />}

          {tab === 'remote' && <>
          <SectionLabel>REMOTE CONTROL</SectionLabel>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>Serve the mobile companion</div>
                <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                  Work with tasks, chats, and sessions from any device on your network — live terminals stream straight from the PTY, chats stream as they generate. Commands run through the same action paths as this UI; execution and credentials never leave this machine. Works over Tailscale/WireGuard (each interface gets its own link) and behind a Cloudflare Tunnel via the public URL.
                </div>
              </div>
              <Switch
                on={s.settings.remoteEnabled === true}
                onToggle={() => updateSettings({ remoteEnabled: !s.settings.remoteEnabled })}
              />
            </div>
            {s.settings.remoteEnabled && <>
            <div style={{ padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Connect links</div>
              {s.remoteInfo ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(s.settings.remotePublicUrl?.trim()
                    ? [{ label: 'public', url: `${s.settings.remotePublicUrl.trim().replace(/\/+$/, '')}/?t=${s.remoteInfo.token}` }]
                    : []
                  ).concat(s.remoteInfo.urls ?? []).map(u => (
                    <ConnectLink key={u.url} label={u.label} url={u.url} />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>starting…</div>
              )}
              <input
                defaultValue={s.settings.remotePublicUrl ?? ''}
                placeholder="Public base URL (Cloudflare Tunnel / MagicDNS) — optional"
                onBlur={e => updateSettings({ remotePublicUrl: e.target.value.trim() })}
                style={{ ...FIELD_STYLE, width: '100%', marginTop: 8 }}
              />
            </div>
            <div style={{ padding: '14px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>URL token</div>
              <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 8 }}>
                Carried in every connect link and persisted across restarts. Editing or regenerating it invalidates existing links; paired devices stay paired.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  key={s.settings.remoteToken ?? ''}
                  className="mono"
                  defaultValue={s.settings.remoteToken ?? ''}
                  placeholder="URL token"
                  onBlur={e => { const v = e.target.value.trim(); if (v.length >= 8 && v !== s.settings.remoteToken) updateSettings({ remoteToken: v, remoteTokenAt: Date.now() }) }}
                  style={{ ...FIELD_STYLE, flex: 1 }}
                />
                <button
                  className="open-btn"
                  title="Mint a new token now — existing connect links stop working"
                  style={{ padding: '7px 11px', fontSize: 11.5, flexShrink: 0 }}
                  onClick={() => updateSettings({ remoteToken: Array.from(crypto.getRandomValues(new Uint8Array(24)), b => (b % 36).toString(36)).join(''), remoteTokenAt: Date.now() })}
                >
                  ↻ Regenerate
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--mut2)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={s.settings.remoteTokenRotate === true}
                    onChange={e => updateSettings({ remoteTokenRotate: e.target.checked, ...(e.target.checked && !s.settings.remoteTokenAt ? { remoteTokenAt: Date.now() } : {}) })}
                  />
                  Auto-rotate the token every
                </label>
                <input
                  type="number"
                  min={1}
                  max={720}
                  defaultValue={s.settings.remoteTokenRotateHours ?? 24}
                  disabled={s.settings.remoteTokenRotate !== true}
                  onBlur={e => { const h = Math.max(1, Math.min(720, Number(e.target.value) || 24)); updateSettings({ remoteTokenRotateHours: h }) }}
                  style={{ ...FIELD_STYLE, width: 70, opacity: s.settings.remoteTokenRotate ? 1 : 0.5 }}
                />
                <span style={{ fontSize: 12, color: 'var(--mut)' }}>hours — connect links must be re-copied after each rotation; paired devices keep working</span>
              </div>
            </div>
            <div style={{ padding: '14px 0' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>Paired devices</div>
              <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 8 }}>
                Each device paired through an explicit approval on this desktop. Revoking locks it out immediately; it must pair again to reconnect.
              </div>
              {(s.settings.remoteDevices ?? []).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--dim)' }}>No devices paired yet — open a connect link on your phone and approve the pairing dialog here.</div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(s.settings.remoteDevices ?? []).map(d => (
                  <span key={d.id} className="mono" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 99, border: '1px solid var(--line2)', color: 'var(--text2)' }}>
                    📱 {d.name || d.id.slice(0, 8)} <span style={{ color: 'var(--faint)' }}>· {new Date(d.at).toLocaleDateString()}</span>
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
            </div>
            </>}
          </div>
          </>}


          {tab === 'tools' && <>
          <SectionLabel>MASTER TOOLS — what Master may do; click a permission to cycle it</SectionLabel>
          <ToolsSection />
          </>}

        </div>
      </div>
    </div>
  )
}
