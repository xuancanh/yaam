import { useMemo, useState } from 'react'
import { useActions, useConductor } from '../../store'
import { isTauri, pickFolder } from '../../native'
import { hexToRgba } from '../../data'
import { ACCENT, SHELLS } from '../../data'

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: "'JetBrains Mono', monospace",
} as const

/** Render a consistent label for session-launch fields. */
function FieldLabel({ children }: { children: string }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--mut)', marginBottom: 5, letterSpacing: 0.3 }}>{children}</div>
}

/** effective model list of a chat-agent type (trimmed, default first) */
function modelsOf(t: { model: string; models?: string[] } | undefined): string[] {
  if (!t) return []
  const list = (t.models ?? []).map(m => m.trim()).filter(Boolean)
  return list.length ? list : t.model ? [t.model] : []
}

/** Launch a terminal session (CLI/template/shell) or a chat-mode agent. */
export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const s = useConductor()
  const { newRealSession, newChatSession, runTemplate } = useActions()
  const [mode, setMode] = useState<'terminal' | 'chat'>('terminal')

  // terminal mode
  const enabledTypes = useMemo(() => s.agentTypes.filter(t => t.enabled), [s.agentTypes])
  const [typeId, setTypeId] = useState(enabledTypes[0]?.id ?? 'shell')
  const [templateId, setTemplateId] = useState('')
  const [shellOverride, setShellOverride] = useState('')
  const [command, setCommand] = useState(enabledTypes[0]?.model ?? '')
  const [task, setTask] = useState('')

  // chat mode
  const chatTypes = s.chatAgentTypes.filter(t => t.enabled)
  const [chatTypeId, setChatTypeId] = useState(chatTypes[0]?.id ?? '')
  const [chatModel, setChatModel] = useState('')
  const [chatName, setChatName] = useState('')

  // shared
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')

  const isShell = typeId === 'shell'
  const isCustom = typeId === 'custom'
  const shell = shellOverride || s.settings.shell || 'zsh'
  const templates = s.templates ?? []
  const tpl = mode === 'terminal' && templateId ? templates.find(t => t.id === templateId) : undefined
  const effectiveCommand = isShell ? `${shell} -i` : command

  const chatType = s.chatAgentTypes.find(t => t.id === chatTypeId) ?? chatTypes[0]
  const chatModels = modelsOf(chatType)
  const effectiveChatModel = chatModel && chatModels.includes(chatModel) ? chatModel : chatModels[0] ?? ''

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

  const canLaunch = mode === 'chat' ? Boolean(chatType) : Boolean(tpl || effectiveCommand.trim())

  // Dispatch a template run, a real PTY session, or a chat-mode agent.
  const launch = () => {
    if (mode === 'chat') {
      if (!chatType) return
      newChatSession(chatName.trim() || undefined, cwd, chatType.id, effectiveChatModel || undefined)
      onClose()
      return
    }
    if (tpl) {
      runTemplate(tpl.id, task.trim() || undefined)
      onClose()
      return
    }
    if (!effectiveCommand.trim()) return
    newRealSession(effectiveCommand, cwd, isShell ? shell : undefined)
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
            ? mode === 'terminal'
              ? 'A CLI in a PTY — output streams into a workspace pane, input goes to its stdin.'
              : 'An in-app agent that chats like Claude Desktop: browses & edits files, runs commands, loads skills, calls MCP servers.'
            : 'Sessions need the desktop app — this browser build cannot spawn processes.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9, padding: 4 }}>
            {([['terminal', 'Terminal'], ['chat', 'Chat']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                style={{
                  flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: mode === id ? hexToRgba(ACCENT, 0.16) : 'transparent',
                  color: mode === id ? 'var(--accent)' : 'var(--mut)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'terminal' && templates.length > 0 && (
            <div>
              <FieldLabel>Template (optional)</FieldLabel>
              <select value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                <option value="">none — configure manually</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name} · {t.mode === 'ephemeral' ? 'one-shot' : 'interactive'}</option>)}
              </select>
            </div>
          )}
          {mode === 'terminal' && !tpl && (
            <div>
              <FieldLabel>Agent type</FieldLabel>
              <select value={typeId} onChange={e => selectType(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                {enabledTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="shell">Terminal</option>
                <option value="custom">Custom command…</option>
              </select>
            </div>
          )}
          {mode === 'terminal' && (tpl ? (
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
          ))}

          {mode === 'chat' && (chatTypes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.6 }}>
              No chat agents enabled — configure one in Settings → Agent Types → Chat agents.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FieldLabel>Chat agent</FieldLabel>
                  <select
                    value={chatType?.id ?? ''}
                    onChange={e => { setChatTypeId(e.target.value); setChatModel('') }}
                    disabled={!isTauri}
                    className="select-field"
                    style={FIELD_STYLE}
                  >
                    {chatTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FieldLabel>Model</FieldLabel>
                  <select
                    value={effectiveChatModel}
                    onChange={e => setChatModel(e.target.value)}
                    disabled={!isTauri || chatModels.length <= 1}
                    className="select-field"
                    style={FIELD_STYLE}
                  >
                    {chatModels.map(m => <option key={m} value={m}>{m}</option>)}
                    {!chatModels.length && <option value="">no models configured</option>}
                  </select>
                </div>
              </div>
              <div>
                <FieldLabel>Name</FieldLabel>
                <input
                  value={chatName}
                  onChange={e => setChatName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') launch() }}
                  placeholder={chatType ? `${chatType.name.toLowerCase()} (optional)` : 'chat (optional)'}
                  disabled={!isTauri}
                  style={FIELD_STYLE}
                />
              </div>
            </>
          ))}

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
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 9, opacity: isTauri && canLaunch ? 1 : 0.45 }}
            onClick={launch}
            disabled={!isTauri || !canLaunch}
          >
            Launch {mode === 'chat'
              ? chatType && <span className="mono" style={{ fontWeight: 400, opacity: 0.75 }}>· {chatType.name}{effectiveChatModel ? ` · ${effectiveChatModel}` : ''}</span>
              : tpl
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
