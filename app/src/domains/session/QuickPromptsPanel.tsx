// Docked "PROMPTS" panel: saved prompts one click away for this session, or
// broadcast to every live session in its tab group. Editable in place.
import { useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { useAppStore } from '../../core/store'
import { terminalSelection } from '../../core/terminals'
import type { Agent } from '../../core/types'
import type { QuickPrompt } from '../../core/entities'
import { mkId } from '../../shared/id'
import { IC, Icon } from '../../components/ui'
import { fillPrompt } from './prompt-compose'
import { DEFAULT_QUICK_PROMPTS, groupPeers, promptsFor, quickPromptsOf } from './quick-prompts'

const FIELD = { width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 6, padding: '5px 8px', color: 'var(--text)', fontSize: 12, outline: 'none' } as const

export function QuickPromptsPanel({ agent }: { agent: Agent }) {
  const all = useConductorSelector(x => x.settings.quickPrompts)
  const list = all ?? DEFAULT_QUICK_PROMPTS
  const peers = useConductorSelector(x => groupPeers(x, agent.id).join(','))
  const { sendPrompt, updateSettings, flash } = useActions()
  const [editing, setEditing] = useState<QuickPrompt | null>(null)
  const shown = promptsFor(list, agent.cwd)

  const run = (p: QuickPrompt, broadcast: boolean) => {
    const text = fillPrompt(p.text, { selection: terminalSelection(agent.id) })
    if (text === null) { flash('Select some terminal output first: this prompt uses {selection}'); return }
    const targets = broadcast ? [agent.id, ...(peers ? peers.split(',') : [])] : [agent.id]
    for (const id of targets) sendPrompt(id, text, `Quick prompt · ${p.label}`)
  }
  const save = (next: QuickPrompt[]) => updateSettings({ quickPrompts: next })
  const commit = (p: QuickPrompt) => {
    const cur = quickPromptsOf(useAppStore.getState())
    const clean = { ...p, label: p.label.trim() || p.text.trim().slice(0, 30), text: p.text.trim(), folder: p.folder?.trim() || undefined }
    if (!clean.text) return
    save(cur.some(x => x.id === p.id) ? cur.map(x => (x.id === p.id ? clean : x)) : [...cur, clean])
    setEditing(null)
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
      {shown.map(p => (
        <div key={p.id} className="qp-row" style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg2)' }}>
          <button
            onClick={() => run(p, false)}
            title={p.text}
            style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: '7px 9px', color: 'var(--text)', cursor: 'pointer' }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.label}{p.folder && <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--accent)', fontWeight: 600 }}>folder</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text}</div>
          </button>
          {peers && (
            <button className="icon-btn" title={`Send to all ${peers.split(',').length + 1} sessions in this tab group`} style={{ width: 24, height: 24, borderRadius: 6 }} onClick={() => run(p, true)}>
              <Icon paths={['M4 12h10', 'M10 6l6 6-6 6', 'M18 5v14']} size={12} stroke={1.8} />
            </button>
          )}
          <button className="icon-btn" title="Edit" style={{ width: 24, height: 24, borderRadius: 6, marginRight: 3 }} onClick={() => setEditing({ ...p })}>
            <Icon paths={['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z']} size={11} stroke={1.7} />
          </button>
        </div>
      ))}
      {shown.length === 0 && !editing && <div style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>No prompts yet.</div>}
      {editing ? (
        <div style={{ border: '1px solid var(--accent-border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--panel2)' }}>
          <input autoFocus value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })} placeholder="Label" style={FIELD} />
          <textarea
            value={editing.text}
            onChange={e => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit(editing); if (e.key === 'Escape') setEditing(null) }}
            rows={4}
            placeholder="Prompt text. {selection} inserts the selected terminal output."
            style={{ ...FIELD, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--mut)' }}>
            <input type="checkbox" checked={!!editing.folder} onChange={e => setEditing({ ...editing, folder: e.target.checked ? (agent.cwd ?? '') : undefined })} disabled={!agent.cwd} />
            Only for <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editing.folder || agent.cwd || 'this folder'}</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="open-btn" onClick={() => commit(editing)} style={{ padding: '4px 12px' }}>Save</button>
            <button className="open-btn" onClick={() => setEditing(null)} style={{ padding: '4px 12px' }}>Cancel</button>
            <div style={{ flex: 1 }} />
            {list.some(x => x.id === editing.id) && (
              <button className="icon-btn danger" title="Delete prompt" style={{ width: 26, height: 26, borderRadius: 6 }}
                onClick={() => { save(quickPromptsOf(useAppStore.getState()).filter(x => x.id !== editing.id)); setEditing(null) }}>
                <Icon paths={IC.close} size={12} stroke={1.8} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <button className="open-btn" style={{ alignSelf: 'flex-start', padding: '4px 10px', fontSize: 12 }} onClick={() => setEditing({ id: mkId('qp'), label: '', text: '' })}>
          + New prompt
        </button>
      )}
    </div>
  )
}
