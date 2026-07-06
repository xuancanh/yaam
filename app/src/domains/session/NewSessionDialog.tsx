import { useMemo, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { isTauri, pickFolder } from '../../core/native'
import { SHELLS } from '../../core/data'

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: 'var(--font-mono)',
} as const

/** Render a consistent label for session-launch fields. */
function FieldLabel({ children }: { children: string }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', marginBottom: 5, letterSpacing: 0.3 }}>{children}</div>
}

/** Launch a terminal session (CLI/template/shell) or a chat-mode agent. */
export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes, settings: x.settings, templates: x.templates }), shallowEqual)
  const { newRealSession, runTemplate } = useActions()

  // terminal mode
  const enabledTypes = useMemo(() => s.agentTypes.filter(t => t.enabled), [s.agentTypes])
  const [typeId, setTypeId] = useState(enabledTypes[0]?.id ?? 'shell')
  const [templateId, setTemplateId] = useState('')
  const [shellOverride, setShellOverride] = useState('')
  const [command, setCommand] = useState(enabledTypes[0]?.model ?? '')
  const [task, setTask] = useState('')

  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')
  const [isolate, setIsolate] = useState(false)
  const [detached, setDetached] = useState(false)

  const isShell = typeId === 'shell'
  const isCustom = typeId === 'custom'
  const shell = shellOverride || s.settings.shell || 'zsh'
  const templates = s.templates ?? []
  const tpl = templateId ? templates.find(t => t.id === templateId) : undefined
  const effectiveCommand = isShell ? `${shell} -i` : command

  // Select an agent type and synchronize its default command.
  const selectType = (id: string) => {
    setTypeId(id)
    if (id === 'custom') setCommand('')
    else if (id !== 'shell') {
      const t = s.agentTypes.find(x => x.id === id)
      if (t) setCommand(t.model)
    }
  }

  // Fill the working directory from the native folder picker.
  const browse = async () => {
    const dir = await pickFolder(cwd || undefined)
    if (dir) setCwd(dir)
  }

  const canLaunch = Boolean(tpl || effectiveCommand.trim())

  // Dispatch a template run or a real PTY session.
  const launch = () => {
    if (tpl) {
      runTemplate(tpl.id, task.trim() || undefined, isolate || undefined)
      onClose()
      return
    }
    if (!effectiveCommand.trim()) return
    newRealSession(effectiveCommand, cwd, isShell ? shell : undefined, isolate || undefined, detached || undefined)
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
            ? 'A CLI in a PTY — output streams into a workspace pane, input goes to its stdin. (Chat agents live in the Chat view.)'
            : 'Sessions need the desktop app — this browser build cannot spawn processes.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {templates.length > 0 && (
            <div>
              <FieldLabel>Template (optional)</FieldLabel>
              <select value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                <option value="">none — configure manually</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} · {t.mode === 'ephemeral' ? 'one-shot' : 'interactive'}</option>)}
              </select>
            </div>
          )}
          {!tpl && (
            <div>
              <FieldLabel>Agent type</FieldLabel>
              <select value={typeId} onChange={e => selectType(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                {enabledTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="shell">Terminal</option>
                <option value="custom">Custom command…</option>
              </select>
            </div>
          )}
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
              <select value={shell} onChange={e => setShellOverride(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
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

          {!tpl && (
            <div>
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
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', userSelect: 'none' }} title="The working folder (a git repo, or a folder whose subfolders are repos) is mirrored into git worktrees on branch yaam/<session>; the session works there and your checkout stays untouched until you merge.">
            <input type="checkbox" checked={isolate} onChange={e => setIsolate(e.target.checked)} disabled={!isTauri} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Isolate in a git worktree</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                Runs on a branch in a mirrored copy — supports multi-repo folders; review &amp; merge when done.
              </span>
            </span>
          </label>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', userSelect: 'none', marginTop: 10 }} title="The session's process runs in a detached host with its own lifecycle — it keeps working after you quit YAAM. Reopen the app and press ▶ to reattach; Stop ends it for real.">
            <input type="checkbox" checked={detached} onChange={e => setDetached(e.target.checked)} disabled={!isTauri} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Detached (survives closing the app)</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                Runs in its own host process; the app attaches to it and can reattach, monitor, and stop it later.
              </span>
            </span>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, opacity: isTauri && canLaunch ? 1 : 0.45 }}
            onClick={launch}
            disabled={!isTauri || !canLaunch}
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
