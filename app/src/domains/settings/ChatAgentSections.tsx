import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { hexToRgba } from '../../core/data'
import { PROVIDERS, providerFor } from '../../master'
import { EditableName, IC, Icon, Switch } from '../../components/ui'
import { DraftInput, DraftTextarea } from '../../components/DraftInput'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

/** Skills registry: reusable instruction packs chat agents load on demand. */
export function SkillsSection() {
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
              <button className="icon-btn danger" title="Remove skill" style={{ width: 24, height: 24 }} onClick={() => { void confirmAction({ title: `Delete skill “${sk.name.slice(0, 40)}”?`, detail: 'The skill and its instructions are removed for every chat. This cannot be undone.' }).then(ok => { if (ok) removeSkill(sk.id) }) }}>
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
export function PersonasSection() {
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
              <button className="icon-btn danger" title="Remove persona" style={{ width: 24, height: 24 }} onClick={() => { void confirmAction({ title: `Delete persona “${pe.name.slice(0, 40)}”?`, detail: 'Chats using it keep running without a persona. This cannot be undone.' }).then(ok => { if (ok) removePersona(pe.id) }) }}>
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
export function SkillRegistriesSection() {
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
            <button className="icon-btn danger" title="Remove registry" style={{ width: 26, height: 26 }} onClick={() => { void confirmAction({ title: `Remove skill registry “${r.name.slice(0, 40)}”?`, detail: 'Its skills disappear from the slash menu and chats. Re-adding the URL restores them.' }).then(ok => { if (ok) removeSkillRegistry(r.id) }) }}>
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
export function AddChatTypeButton() {
  const { addChatAgentType } = useActions()
  return (
    <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={addChatAgentType}>
      + Add chat agent
    </button>
  )
}

/** Configurable chat-agent types: provider, model, credentials, persona. */
export function ChatTypesSection() {
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
                    onClick={() => { void confirmAction({ title: `Delete chat agent “${t.name.slice(0, 40)}”?`, detail: 'Its configuration and API key entry are removed. Existing chats fall back to another enabled agent.' }).then(ok => { if (ok) deleteChatAgentType(t.id) }) }}
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
                <DraftTextarea
                  value={(t.models ?? (t.model ? [t.model] : [])).join('\n')}
                  onCommit={v => {
                    const models = v.split('\n').map(x => x.trim())
                    updateChatAgentType(t.id, { models, model: models.find(Boolean) ?? '' })
                  }}
                  placeholder={'models — one per line, first is the default\n' + (prov.models[0] ?? 'model-id')}
                  rows={Math.min(5, Math.max(2, (t.models?.length ?? 1) + 1))}
                  title="Pickable per session in the new-session dialog; the first line is the default"
                  style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5, resize: 'vertical', minHeight: 34 }}
                />
                {t.provider !== 'bedrock' && (
                  <DraftInput
                    type="password"
                    value={t.apiKey ?? ''}
                    onCommit={v => updateChatAgentType(t.id, { apiKey: v || undefined })}
                    placeholder={sharesMaster ? 'API key (empty = share Master Brain credentials)' : 'API key · ' + prov.keyHint}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                {needsBase && (
                  <DraftInput
                    value={t.baseUrl ?? ''}
                    onCommit={v => updateChatAgentType(t.id, { baseUrl: v || undefined })}
                    placeholder={prov.protocol === 'anthropic' ? 'base URL · https://…  (Anthropic-compatible /v1/messages)' : 'base URL · https://…/v1  (OpenAI-compatible)'}
                    style={{ ...FIELD_STYLE, width: '100%', marginTop: 6, padding: '5px 9px', fontSize: 11.5 }}
                  />
                )}
                <DraftTextarea
                  value={t.systemPrompt ?? ''}
                  onCommit={v => updateChatAgentType(t.id, { systemPrompt: v || undefined })}
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
