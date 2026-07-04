import { useMemo, useState } from 'react'
import { useActions, useConductor } from '../../store'
import { isTauri, pickFolder } from '../../native'
import { SHELLS } from '../../data'

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
} as const

function FieldLabel({ children }: { children: string }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', marginBottom: 5, letterSpacing: 0.3 }}>{children}</div>
}

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const s = useConductor()
  const { newRealSession, runTemplate } = useActions()
  const enabledTypes = useMemo(() => s.agentTypes.filter(t => t.enabled), [s.agentTypes])
  const [typeId, setTypeId] = useState(enabledTypes[0]?.id ?? 'shell')
  const [shell, setShell] = useState(s.settings.shell || 'zsh')
  const [command, setCommand] = useState(enabledTypes[0]?.model ?? '')
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')
  const [task, setTask] = useState('')

  const isShell = typeId === 'shell'
  const isCustom = typeId === 'custom'
  const templates = s.templates ?? []
  const tpl = typeId.startsWith('tpl:') ? templates.find(t => t.id === typeId.slice(4)) : undefined
  const effectiveCommand = isShell ? `${shell} -i` : command

  const selectType = (id: string) => {
    setTypeId(id)
    if (id === 'custom') setCommand('')
    else if (id !== 'shell' && !id.startsWith('tpl:')) {
      const t = s.agentTypes.find(x => x.id === id)
      if (t) setCommand(t.model)
    }
  }

  const browse = async () => {
    const dir = await pickFolder(cwd || undefined)
    if (dir) setCwd(dir)
  }

  const launch = () => {
    if (tpl) {
      runTemplate(tpl.id, task.trim() || undefined)
      onClose()
      return
    }
    if (!effectiveCommand.trim()) return
    newRealSession(effectiveCommand, cwd)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '15vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 500, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New agent session</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          {isTauri
            ? 'Pick an agent type or a plain terminal — output streams into a workspace pane, input goes to its stdin.'
            : 'Sessions need the desktop app — this browser build cannot spawn processes.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <FieldLabel>Agent type</FieldLabel>
            <select value={typeId} onChange={e => selectType(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
              {enabledTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              <option value="shell">Terminal</option>
              <option value="custom">Custom command…</option>
              {templates.length > 0 && (
                <optgroup label="Templates">
                  {templates.map(t => <option key={t.id} value={`tpl:${t.id}`}>{t.name} · {t.mode}</option>)}
                </optgroup>
              )}
            </select>
          </div>
          {tpl ? (
            <div>
              <FieldLabel>Task</FieldLabel>
              <textarea
                value={task}
                onChange={e => setTask(e.target.value)}
                placeholder={tpl.prompt.includes('{task}') ? 'what should it do? (fills {task} in the template prompt)' : 'appended to the template prompt (optional)'}
                rows={3}
                style={{ ...FIELD_STYLE, resize: 'vertical' }}
              />
              <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 5, lineHeight: 1.5 }}>
                {tpl.mode === 'ephemeral' ? 'One-shot: runs the task and exits by itself.' : 'Interactive: stays open after the prompt.'}
                {tpl.cwd ? ` · cwd ${tpl.cwd}` : ''}
              </div>
            </div>
          ) : isShell ? (
            <div>
              <FieldLabel>Shell</FieldLabel>
              <select value={shell} onChange={e => setShell(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <FieldLabel>Command</FieldLabel>
              <input
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch() }}
                placeholder={isCustom ? 'e.g. python3 -i, node, htop' : 'command'}
                disabled={!isTauri}
                style={FIELD_STYLE}
              />
            </div>
          )}
          {!tpl && <div>
            <FieldLabel>Working directory</FieldLabel>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={cwd}
                onChange={e => setCwd(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch() }}
                placeholder="folder (optional)"
                disabled={!isTauri}
                style={FIELD_STYLE}
              />
              <button className="open-btn" style={{ flex: 'none', padding: '0 14px' }} onClick={browse} disabled={!isTauri}>
                Browse…
              </button>
            </div>
          </div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, opacity: isTauri && (tpl || effectiveCommand.trim()) ? 1 : 0.45 }}
            onClick={launch}
            disabled={!isTauri || (!tpl && !effectiveCommand.trim())}
          >
            Launch {tpl
              ? <span className="mono" style={{ fontWeight: 400, opacity: 0.75 }}>· {tpl.name}</span>
              : effectiveCommand.trim() && <span className="mono" style={{ fontWeight: 400, opacity: 0.75 }}>· {effectiveCommand.trim().slice(0, 28)}</span>}
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

