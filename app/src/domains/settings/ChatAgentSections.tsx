import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { hexToRgba } from '../../core/data'
import { PROVIDERS, providerFor } from '../../master'
import type { ChatAgentType } from '../../core/types'
import { EditableName, IC, Icon, Switch } from '../../components/ui'
import { DraftInput, DraftTextarea } from '../../components/DraftInput'
import { DialogField, DialogFooter, DialogGrid, DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

/** Spacious popup for name + description + instructions entities (skills). */
function InstructionPackDialog({ noun, value, hints, onPatch, onDelete, onClose }: {
  noun: 'skill'
  value: { name: string; description: string; body: string }
  hints: { name: string; description: string; body: string; deleteDetail: string }
  onPatch: (patch: Partial<{ name: string; description: string; body: string }>) => void
  onDelete: () => void
  onClose: () => void
}) {
  return (
    <EntityDialog onClose={onClose} width={720}>
      <DialogHeader
        onClose={onClose}
        title={<span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{value.name || `unnamed ${noun}`}</span>}
        sub={<>{value.description || 'no description'} · changes save on blur</>}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <DialogGrid>
          <DialogField label="NAME" hint={hints.name}>
            <DraftInput
              value={value.name}
              onCommit={v => onPatch({ name: v.replace(/\s+/g, '-').toLowerCase() })}
              placeholder={`${noun}-name`}
              style={{ ...FIELD_STYLE, width: '100%' }}
            />
          </DialogField>
          <DialogField label="DESCRIPTION" hint={hints.description}>
            <DraftInput
              value={value.description}
              onCommit={v => onPatch({ description: v })}
              placeholder="one line"
              style={{ ...FIELD_STYLE, width: '100%', fontFamily: 'var(--font-sans)' }}
            />
          </DialogField>
        </DialogGrid>
        <DialogField label="INSTRUCTIONS" hint={hints.body}>
          <DraftTextarea
            value={value.body}
            onCommit={v => onPatch({ body: v })}
            placeholder="the instructions injected when a chat agent loads this skill"
            rows={12}
            style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.55 }}
          />
        </DialogField>
      </div>
      <DialogFooter onClose={onClose}>
        <button
          className="deny-btn"
          style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
          onClick={() => {
            void confirmAction({ title: `Delete ${noun} “${value.name.slice(0, 40)}”?`, detail: hints.deleteDetail })
              .then(ok => { if (ok) { onDelete(); onClose() } })
          }}
        >
          Delete
        </button>
      </DialogFooter>
    </EntityDialog>
  )
}

/** One compact skill row; click for the full editor popup. */
function InstructionPackRow({ name, description, extra, onOpen }: {
  name: string
  description: string
  extra?: string
  onOpen: () => void
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--line-soft)' }}>
      <div className="palette-item" onClick={onOpen} title="Click to view & edit" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 6px', margin: '0 -6px', cursor: 'pointer', borderRadius: 7 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</span>
          <span style={{ fontSize: 11.5, color: 'var(--mut)', marginLeft: 8 }}>{description || 'no description'}</span>
        </div>
        {extra && <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>{extra}</span>}
      </div>
    </div>
  )
}

/** Skills registry: reusable instruction packs chat agents load on demand.
 *  Compact rows; click one for the full editor popup. */
export function SkillsSection() {
  const s = useConductorSelector(x => ({ skills: x.skills }), shallowEqual)
  const { addSkill, updateSkill, removeSkill } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)
  const open = openId ? s.skills.find(sk => sk.id === openId) : undefined

  return (
    <>
      <SectionLabel>SKILLS — reusable instructions for chat agents · click one to edit</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        {s.skills.map(sk => (
          <InstructionPackRow
            key={sk.id}
            name={sk.name}
            description={sk.description}
            extra={sk.body.trim() ? `${sk.body.trim().split(/\s+/).length} words` : 'empty'}
            onOpen={() => setOpenId(sk.id)}
          />
        ))}
        <div style={{ padding: '12px 0' }}>
          <button className="open-btn" style={{ flex: 'none', padding: '6px 13px', fontSize: 12 }} onClick={() => setOpenId(addSkill())}>
            New skill
          </button>
        </div>
      </div>
      {open && (
        <InstructionPackDialog
          noun="skill"
          value={open}
          hints={{
            name: 'agents load it by this',
            description: 'agents pick skills by this line',
            body: 'injected into the chat when the skill is loaded',
            deleteDetail: 'The skill and its instructions are removed for every chat. This cannot be undone.',
          }}
          onPatch={patch => updateSkill(open.id, patch)}
          onDelete={() => removeSkill(open.id)}
          onClose={() => setOpenId(null)}
        />
      )}
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

function ChatTypeAvatar({ t, size = 38 }: { t: ChatAgentType; size?: number }) {
  return (
    <div className="mono" style={{
      width: size, height: size, borderRadius: 10, background: hexToRgba('#7FD1FF', 0.14),
      border: '1px solid ' + hexToRgba('#7FD1FF', 0.4), display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#7FD1FF', flexShrink: 0,
    }}>
      {t.name.slice(0, 2).toUpperCase()}
    </div>
  )
}

/** Credential summary for one chat agent type. */
function credLabel(t: ChatAgentType, masterProvider: string): string {
  if (t.provider === 'bedrock') return 'AWS chain'
  if (t.apiKey) return 'own key'
  if (t.provider === masterProvider) return 'shares Master creds'
  return 'no credentials'
}

/** Spacious popup for one chat agent type: provider, models, credentials, persona. */
function ChatTypeDialog({ t, onClose }: { t: ChatAgentType; onClose: () => void }) {
  const masterProvider = useConductorSelector(x => x.settings.provider)
  const { updateChatAgentType, deleteChatAgentType } = useActions()
  const upd = (patch: Partial<Omit<ChatAgentType, 'id'>>) => updateChatAgentType(t.id, patch)
  const prov = providerFor(t.provider)
  const needsBase = prov.models.length === 0
  const sharesMaster = t.provider === masterProvider && !t.apiKey

  return (
    <EntityDialog onClose={onClose} width={720}>
      <DialogHeader
        onClose={onClose}
        lead={<ChatTypeAvatar t={t} />}
        title={<EditableName name={t.name} onRename={name => upd({ name })} fontSize={15} />}
        sub={<>{prov.label} · {t.model || 'no model'} · {credLabel(t, masterProvider)} · changes save on blur</>}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <DialogField label="DESCRIPTION" hint="shown in pickers">
          <DraftInput value={t.desc ?? ''} onCommit={v => upd({ desc: v || undefined })} placeholder="what this agent is for" style={{ ...FIELD_STYLE, width: '100%', fontFamily: 'var(--font-sans)' }} />
        </DialogField>

        <DialogGrid>
          <DialogField label="PROVIDER">
            <select
              value={t.provider}
              onChange={e => {
                const next = providerFor(e.target.value)
                upd({ provider: next.id, models: next.models.length ? next.models : [], model: next.models[0] ?? '' })
              }}
              className="select-field"
              style={{ ...FIELD_STYLE, width: '100%' }}
            >
              {PROVIDERS.map(pr => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
            </select>
          </DialogField>
          {t.provider !== 'bedrock' && (
            <DialogField label="API KEY" hint={sharesMaster ? 'empty = share Master Brain credentials' : prov.keyHint}>
              <DraftInput
                type="password"
                value={t.apiKey ?? ''}
                onCommit={v => upd({ apiKey: v || undefined })}
                placeholder={sharesMaster ? 'shares Master Brain credentials' : prov.keyHint}
                style={{ ...FIELD_STYLE, width: '100%' }}
              />
            </DialogField>
          )}
        </DialogGrid>

        {needsBase && (
          <DialogField label="BASE URL" hint={prov.protocol === 'anthropic' ? 'Anthropic-compatible /v1/messages endpoint' : 'OpenAI-compatible endpoint root'}>
            <DraftInput
              value={t.baseUrl ?? ''}
              onCommit={v => upd({ baseUrl: v || undefined })}
              placeholder={prov.protocol === 'anthropic' ? 'https://…' : 'https://…/v1'}
              style={{ ...FIELD_STYLE, width: '100%' }}
            />
          </DialogField>
        )}

        <DialogField label="MODELS" hint="one per line — pickable per chat; the first is the default">
          <DraftTextarea
            value={(t.models ?? (t.model ? [t.model] : [])).join('\n')}
            onCommit={v => {
              const models = v.split('\n').map(x => x.trim())
              upd({ models, model: models.find(Boolean) ?? '' })
            }}
            placeholder={prov.models[0] ?? 'model-id'}
            rows={Math.min(8, Math.max(3, (t.models?.length ?? 1) + 1))}
            style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', lineHeight: 1.5 }}
          />
          {prov.models.length > 0 && (
            <button
              className="open-btn"
              title="Fill the model list with this provider's known models"
              style={{ flex: 'none', padding: '4px 12px', fontSize: 11, marginTop: 6 }}
              onClick={() => upd({ models: prov.models, model: prov.models[0] })}
            >
              Fill with {prov.label} defaults
            </button>
          )}
        </DialogField>

        <DialogField label="PERSONA" hint="optional · appended to the agent's system prompt">
          <DraftTextarea
            value={t.systemPrompt ?? ''}
            onCommit={v => upd({ systemPrompt: v || undefined })}
            placeholder="voice, role, house rules…"
            rows={4}
            style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', lineHeight: 1.5, fontFamily: 'var(--font-sans)' }}
          />
        </DialogField>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text)' }}>Enabled</b><br />
            <span style={{ color: 'var(--dim)' }}>offered when starting new chats</span>
          </div>
          <Switch on={t.enabled} onToggle={() => upd({ enabled: !t.enabled })} />
        </div>
      </div>

      <DialogFooter onClose={onClose}>
        <button
          className="deny-btn"
          style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
          onClick={() => {
            void confirmAction({ title: `Delete chat agent “${t.name.slice(0, 40)}”?`, detail: 'Its configuration and API key entry are removed. Existing chats fall back to another enabled agent.' })
              .then(ok => { if (ok) { deleteChatAgentType(t.id); onClose() } })
          }}
        >
          Delete
        </button>
      </DialogFooter>
    </EntityDialog>
  )
}

/** Small header button that adds a chat-agent type and opens its editor. */
export function AddChatTypeButton({ onAdded }: { onAdded?: (id: string) => void }) {
  const { addChatAgentType } = useActions()
  return (
    <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={() => { const id = addChatAgentType(); onAdded?.(id) }}>
      + Add chat agent
    </button>
  )
}

/** Chat-agent types as compact cards; click one for the full editor popup. */
export function ChatTypesSection({ openId, setOpenId }: { openId: string | null; setOpenId: (id: string | null) => void }) {
  const s = useConductorSelector(x => ({ chatAgentTypes: x.chatAgentTypes, settings: x.settings }), shallowEqual)
  const { updateChatAgentType } = useActions()
  const open = openId ? s.chatAgentTypes.find(t => t.id === openId) : undefined
  return (
    <>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', marginBottom: 26 }}>
        {s.chatAgentTypes.map(t => {
          const prov = providerFor(t.provider)
          return (
            <div
              key={t.id}
              className="palette-item"
              onClick={() => setOpenId(t.id)}
              style={{
                background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
                display: 'flex', gap: 12, cursor: 'pointer', opacity: t.enabled ? 1 : 0.65,
              }}
            >
              <ChatTypeAvatar t={t} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                  <span onClick={e => e.stopPropagation()} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                    <Switch on={t.enabled} onToggle={() => updateChatAgentType(t.id, { enabled: !t.enabled })} />
                  </span>
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {prov.label} · {t.model || 'no model'}{(t.models?.length ?? 0) > 1 ? ` +${(t.models?.length ?? 1) - 1}` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 5 }}>
                  {credLabel(t, s.settings.provider)}{t.systemPrompt ? ' · persona' : ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {open && <ChatTypeDialog t={open} onClose={() => setOpenId(null)} />}
    </>
  )
}
