import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { hexToRgba } from '../../core/data'
import type { AgentType } from '../../core/types'
import { EditableName, Switch } from '../../components/ui'
import { DraftInput, DraftTextarea } from '../../components/DraftInput'
import { DialogField, DialogFooter, DialogGrid, DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'
import { confirmAction } from '../../components/Confirm'

function TypeAvatar({ t, size = 38 }: { t: AgentType; size?: number }) {
  return (
    <div className="mono" style={{
      width: size, height: size, borderRadius: 10, background: hexToRgba(t.color, 0.14),
      border: `1px solid ${hexToRgba(t.color, 0.4)}`, display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: 12, fontWeight: 600, color: t.color, flexShrink: 0,
    }}>
      {t.name.slice(0, 2).toUpperCase()}
    </div>
  )
}

/** Spacious popup for one terminal agent type — every launch/resume option. */
function TypeDialog({ t, onClose }: { t: AgentType; onClose: () => void }) {
  const { toggleAgentType, setAgentTypeCmd, updateAgentType, deleteAgentType } = useActions()
  const upd = (patch: Partial<AgentType>) => updateAgentType(t.id, patch)
  return (
    <EntityDialog onClose={onClose} width={720}>
      <DialogHeader
        onClose={onClose}
        lead={<TypeAvatar t={t} />}
        title={<EditableName name={t.name} onRename={name => upd({ name })} fontSize={15} />}
        sub={<>{t.model || 'no launch command'} · {t.enabled ? 'enabled' : 'disabled'} · {t.tools} tools · changes save on blur</>}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <DialogField label="DESCRIPTION" hint="shown in pickers">
          <DraftInput value={t.desc} onCommit={v => upd({ desc: v })} placeholder="what this CLI is" style={{ ...FIELD_STYLE, width: '100%', fontFamily: 'var(--font-sans)' }} />
        </DialogField>

        <DialogField label="LAUNCH COMMAND" hint="run in a PTY session with your login shell">
          <DraftInput value={t.model} onCommit={v => setAgentTypeCmd(t.id, v)} placeholder="e.g. claude" style={{ ...FIELD_STYLE, width: '100%' }} />
        </DialogField>

        <DialogField label="ENVIRONMENT" hint="one KEY=value per line, applied at launch">
          <DraftTextarea
            value={t.env ?? ''}
            onCommit={v => upd({ env: v })}
            placeholder={'ANTHROPIC_MODEL=claude-sonnet-5\nHTTP_PROXY=…'}
            rows={4}
            style={{ ...FIELD_STYLE, width: '100%', resize: 'vertical', lineHeight: 1.5 }}
          />
        </DialogField>

        <DialogGrid>
          <DialogField label="RESUME COMMAND" hint="{id} = captured session id">
            <DraftInput value={t.resumeCmd ?? ''} onCommit={v => upd({ resumeCmd: v || undefined })} placeholder="e.g. claude --resume {id}" style={{ ...FIELD_STYLE, width: '100%' }} />
          </DialogField>
          <DialogField label="RESUME FALLBACK" hint="when no session id was captured">
            <DraftInput value={t.resumeFallbackCmd ?? ''} onCommit={v => upd({ resumeFallbackCmd: v || undefined })} placeholder="e.g. claude --continue" style={{ ...FIELD_STYLE, width: '100%' }} />
          </DialogField>
        </DialogGrid>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10,
        }}>
          <div style={{ flex: 1, fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text)' }}>Enabled</b><br />
            <span style={{ color: 'var(--dim)' }}>offered in the new-session dialog, templates & tasks</span>
          </div>
          <Switch on={t.enabled} onToggle={() => toggleAgentType(t.id)} />
        </div>
      </div>

      <DialogFooter onClose={onClose}>
        {t.custom && (
          <button
            className="deny-btn"
            style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
            onClick={() => {
              void confirmAction({ title: `Delete agent type “${t.name.slice(0, 40)}”?`, detail: 'Sessions, templates, and tasks referencing it fall back to defaults. This cannot be undone.' })
                .then(ok => { if (ok) { deleteAgentType(t.id); onClose() } })
            }}
          >
            Delete
          </button>
        )}
      </DialogFooter>
    </EntityDialog>
  )
}

/** Settings → Terminal Agents: compact cards; click one for the full editor. */
export function TerminalAgentsSection() {
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes }), shallowEqual)
  const { addAgentType, toggleAgentType } = useActions()
  const [openId, setOpenId] = useState<string | null>(null)
  const open = openId ? s.agentTypes.find(t => t.id === openId) : undefined

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 11 }}>
        <SectionLabel>TERMINAL AGENTS — external CLIs in PTY sessions · click one to configure</SectionLabel>
        <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5, marginBottom: 11 }} onClick={() => setOpenId(addAgentType())}>
          + Add terminal agent
        </button>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', marginBottom: 26 }}>
        {s.agentTypes.map(t => (
          <div
            key={t.id}
            className="palette-item"
            onClick={() => setOpenId(t.id)}
            style={{
              background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: 14,
              display: 'flex', gap: 12, cursor: 'pointer', opacity: t.enabled ? 1 : 0.65,
            }}
          >
            <TypeAvatar t={t} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                <span onClick={e => e.stopPropagation()} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <Switch on={t.enabled} onToggle={() => toggleAgentType(t.id)} />
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {t.desc || 'no description'}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                $ {t.model || '—'}{t.env?.trim() ? '  · env' : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
      {open && <TypeDialog t={open} onClose={() => setOpenId(null)} />}
    </>
  )
}
