import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { isTauri, pickFolder } from '../../core/native'
import { SHELLS } from '../../core/data'
import { recentCwdsFor, splitPath } from './recent-cwds'
import { sortByUsage } from './type-usage'

const FIELD_STYLE = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: 'var(--font-mono)',
} as const

/** Section label for session-launch fields. */
function FieldLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 7 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.8, textTransform: 'uppercase' }}>{children}</span>
      {aside && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dim)' }}>{aside}</span>}
    </div>
  )
}

/** Selectable chip used for agent types. */
function Chip({ active, color, label, title, onClick, disabled }: { active: boolean; color?: string; label: string; title?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', borderRadius: 9, fontSize: 12.5,
        fontWeight: active ? 600 : 500, cursor: 'pointer', textAlign: 'left', minWidth: 0,
        background: active ? 'var(--accent-faint)' : 'var(--bg)',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--line)'}`,
        color: active ? 'var(--text)' : 'var(--mut2, var(--mut))',
        transition: 'border-color .12s, background .12s',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 3, flex: 'none', background: color ?? 'var(--faint)' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
}

/** Checkbox row with a title and a one-line explanation. */
function Toggle({ checked, onChange, title, detail, tip, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; detail: string; tip?: string; disabled?: boolean }) {
  return (
    <label title={tip} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer', userSelect: 'none' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} style={{ marginTop: 2 }} />
      <span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--dim)', marginTop: 2, lineHeight: 1.45 }}>{detail}</span>
      </span>
    </label>
  )
}

/** Launch a terminal session (CLI/template/shell) or a chat-mode agent. */
export function NewSessionDialog({ onClose, initialCwd }: { onClose: () => void; initialCwd?: string }) {
  const s = useConductorSelector(x => ({ agentTypes: x.agentTypes, settings: x.settings, templates: x.templates, agents: x.agents }), shallowEqual)
  const { newRealSession, runTemplate } = useActions()

  // terminal mode
  const enabledTypes = useMemo(() => s.agentTypes.filter(t => t.enabled), [s.agentTypes])
  // most-used first; frozen at open so chips don't reshuffle under the cursor
  const [typeOrder] = useState(() => sortByUsage([...enabledTypes.map(t => t.id), 'shell', 'custom'], s.settings, s.agents))
  const [typeId, setTypeId] = useState(typeOrder[0] ?? 'shell')
  const [showAllTypes, setShowAllTypes] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [shellOverride, setShellOverride] = useState('')
  const [command, setCommand] = useState(() => enabledTypes.find(t => t.id === typeOrder[0])?.model ?? '')
  const [task, setTask] = useState('')

  const [cwd, setCwd] = useState(initialCwd || s.settings.defaultCwd || '')
  const [isolate, setIsolate] = useState(false)
  const [sandbox, setSandbox] = useState(false)
  // detached by default: sessions survive quitting YAAM unless opted out
  const [detached, setDetached] = useState(isTauri)

  // remote machine (ssh + tmux); '' = run locally
  const machines = s.settings.machines ?? []
  const [machineId, setMachineId] = useState('')
  const machine = machines.find(m => m.id === machineId)
  // switching machine prefills the working dir from its default (local ↔ remote
  // paths differ, so replace rather than keep)
  const selectMachine = (id: string) => {
    setMachineId(id)
    const m = machines.find(x => x.id === id)
    setCwd(m ? (m.remoteDir ?? '') : (s.settings.defaultCwd || ''))
  }

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

  const machineIncomplete = Boolean(machine && (!machine.host?.trim() || !machine.user?.trim()))
  const templateMachine = tpl?.machineId ? machines.find(m => m.id === tpl.machineId) : undefined
  const sandboxCwd = tpl
    ? (tpl.cwd || templateMachine?.remoteDir || (!templateMachine ? s.settings.defaultCwd : '') || '')
    : (cwd || machine?.remoteDir || '')
  const sandboxNeedsCwd = sandbox && (!sandboxCwd.trim() || sandboxCwd.trim() === '~' || sandboxCwd.trim() === '/')
  const needsCwd = !tpl && !cwd.trim()
  // dir is the folder a launch would use: the field, or a double-clicked recent
  const canLaunchIn = (dir: string) => {
    if (machineIncomplete) return false
    if (tpl) return !sandboxNeedsCwd
    return Boolean(effectiveCommand.trim()) && Boolean(dir) && !(sandbox && !isShell && (dir === '~' || dir === '/'))
  }
  const canLaunch = canLaunchIn(cwd.trim())
  const recent = useMemo(() => recentCwdsFor(s.settings, s.agents, machineId || undefined), [s.settings, s.agents, machineId])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const advancedOn = [tpl && 'template', isolate && !machine && 'worktree', sandbox && !(isShell && !tpl) && 'sandbox'].filter(Boolean) as string[]

  // Dispatch a template run or a real PTY session.
  const launch = (dir = cwd) => {
    const d = dir.trim()
    if (!isTauri || !canLaunchIn(d)) return
    if (tpl) {
      // sandbox: checked = the template's config (or defaults); unchecked = explicitly off
      runTemplate(tpl.id, task.trim() || undefined, isolate || undefined, sandbox ? (tpl.sandbox ?? {}) : false)
      onClose()
      return
    }
    // worktree isolation is local-only; detached = tmux on a machine, setsid host locally
    newRealSession(effectiveCommand, d, isShell ? shell : undefined, machine ? false : (isolate || undefined), detached || undefined, machineId || undefined, sandbox && !isShell ? {} : undefined, isShell || isCustom ? undefined : typeId)
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launch() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // one row (TYPE_COLS chips) by default; the last slot expands the rest.
  // The selected type always stays visible in the collapsed row.
  const TYPE_COLS = 4
  const chipFor = (id: string) => {
    if (id === 'shell') return <Chip key={id} active={isShell} color="var(--mut)" label="Terminal" title="A plain interactive shell" onClick={() => selectType('shell')} disabled={!isTauri} />
    if (id === 'custom') return <Chip key={id} active={isCustom} color="var(--faint)" label="Custom…" title="Any command, e.g. python3 -i, htop" onClick={() => selectType('custom')} disabled={!isTauri} />
    const t = enabledTypes.find(x => x.id === id)
    return t ? <Chip key={id} active={typeId === id} color={t.color} label={t.name} title={t.desc} onClick={() => selectType(id)} disabled={!isTauri} /> : null
  }
  const overflow = typeOrder.length > TYPE_COLS
  let visibleTypes = typeOrder
  if (overflow && !showAllTypes) {
    visibleTypes = typeOrder.slice(0, TYPE_COLS - 1)
    if (!visibleTypes.includes(typeId)) visibleTypes = [...visibleTypes.slice(0, -1), typeId]
  }
  const moreBtn = overflow && (
    <button
      type="button"
      onClick={() => setShowAllTypes(v => !v)}
      aria-expanded={showAllTypes}
      style={{ padding: '7px 11px', borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', border: '1px dashed var(--line2)', color: 'var(--mut)' }}
    >
      {showAllTypes ? 'Show less' : `+${typeOrder.length - visibleTypes.length} more`}
    </button>
  )
  const typeChips = (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TYPE_COLS}, minmax(0, 1fr))`, gap: 6 }}>
      {visibleTypes.map(chipFor)}
      {moreBtn}
    </div>
  )

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', backdropFilter: 'blur(3px)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '10vh' }}
    >
      <div
        role="dialog"
        aria-label="New agent session"
        onClick={e => e.stopPropagation()}
        style={{ width: 560, maxWidth: '94vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 16, boxShadow: '0 30px 80px rgba(0,0,0,.55)', overflow: 'hidden', animation: 'cfade .14s ease-out' }}
      >
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--line)' }}>
          <div className="grotesk" style={{ fontWeight: 600, fontSize: 16 }}>New agent session</div>
          <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 3 }}>
            {isTauri ? 'Pick an agent and a folder to work in.' : 'Sessions need the desktop app; this browser build cannot spawn processes.'}
          </div>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
          {tpl ? (
            <div>
              <FieldLabel aside={<>{tpl.mode === 'ephemeral' ? 'one-shot' : 'interactive'}{tpl.cwd ? ` · ${tpl.cwd}` : ''}</>}>Task · {tpl.name}</FieldLabel>
              <textarea
                value={task}
                onChange={e => setTask(e.target.value)}
                placeholder={tpl.prompt.includes('{task}') ? 'What should it do? (fills {task} in the template prompt)' : 'Appended to the template prompt (optional)'}
                rows={3}
                autoFocus
                style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
          ) : (
            <>
              <div>
                <FieldLabel>Agent</FieldLabel>
                {typeChips}
                <div style={{ marginTop: 8 }}>
                  {isShell ? (
                    <select value={shell} onChange={e => setShellOverride(e.target.value)} disabled={!isTauri} className="select-field" style={{ ...FIELD_STYLE, padding: '7px 10px', fontSize: 12 }}>
                      {SHELLS.map(sh => <option key={sh} value={sh}>{sh}</option>)}
                    </select>
                  ) : (
                    <input
                      value={command}
                      onChange={e => setCommand(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') launch() }}
                      placeholder={isCustom ? 'e.g. python3 -i, node, htop' : 'command'}
                      aria-label="Command"
                      disabled={!isTauri}
                      autoFocus={isCustom}
                      style={{ ...FIELD_STYLE, padding: '7px 10px', fontSize: 12, color: 'var(--mut)' }}
                    />
                  )}
                </div>
              </div>

              {machines.length > 0 && (
                <div>
                  <FieldLabel>Run on</FieldLabel>
                  <select value={machineId} onChange={e => selectMachine(e.target.value)} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                    <option value="">This machine (local)</option>
                    {machines.map(m => {
                      const incomplete = !m.host?.trim() || !m.user?.trim()
                      return <option key={m.id} value={m.id} disabled={incomplete}>{m.label || 'Unnamed'}{incomplete ? ' · incomplete, set user@host in Settings' : ` · ${m.user}@${m.host}`}</option>
                    })}
                  </select>
                  {machine && (
                    <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 5, lineHeight: 1.5 }}>
                      Runs over SSH inside tmux on {machine.host}. The agent CLI and tmux must be installed there.
                    </div>
                  )}
                </div>
              )}

              <div>
                <FieldLabel aside={needsCwd ? <span style={{ color: 'var(--amber)' }}>required</span> : undefined}>{machine ? `Folder on ${machine.label || machine.host}` : 'Folder'}</FieldLabel>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={cwd}
                    onChange={e => setCwd(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') launch() }}
                    placeholder={machine ? '/path/on/remote/host' : '~/path/to/project'}
                    aria-label="Working folder"
                    aria-required
                    disabled={!isTauri}
                    style={FIELD_STYLE}
                  />
                  {!machine && (
                    <button className="open-btn" style={{ flex: 'none', padding: '0 14px' }} onClick={browse} disabled={!isTauri}>
                      Browse…
                    </button>
                  )}
                </div>
                {recent.length > 0 && (
                  <div style={{ marginTop: 8, border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '6px 11px', fontSize: 10.5, color: 'var(--dim)', background: 'var(--bg)', borderBottom: '1px solid var(--line)', letterSpacing: 0.4 }}>RECENT</div>
                    {recent.map((path, i) => {
                      const { name, parent } = splitPath(path)
                      const active = cwd.trim().replace(/\/+$/, '') === path
                      return (
                        <button
                          key={path}
                          type="button"
                          title={`${path}\nDouble-click to launch here`}
                          onClick={() => setCwd(path)}
                          onDoubleClick={() => launch(path)}
                          disabled={!isTauri}
                          style={{
                            display: 'flex', alignItems: 'baseline', gap: 9, width: '100%', padding: '7px 11px', textAlign: 'left', cursor: 'pointer',
                            background: active ? 'var(--accent-faint)' : 'transparent', border: 'none',
                            borderTop: i ? '1px solid var(--line)' : 'none',
                            boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none', color: 'var(--text)',
                          }}
                        >
                          <span style={{ fontSize: 12.5, fontWeight: 600, flex: 'none', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                          <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', flex: 1, minWidth: 0 }}>{parent}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              aria-expanded={showAdvanced || !!tpl}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--mut)', fontSize: 12, fontWeight: 600 }}
            >
              <span style={{ display: 'inline-block', width: 10, transform: showAdvanced || tpl ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}>›</span>
              Advanced
              <span style={{ fontWeight: 400, color: 'var(--dim)' }}>template, worktree, sandbox</span>
              {advancedOn.length > 0 && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
                  {advancedOn.map(x => <span key={x} style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600 }}>{x}</span>)}
                </span>
              )}
            </button>
            {(showAdvanced || tpl) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, paddingLeft: 18 }}>
                {templates.length > 0 && (
                  <div>
                    <FieldLabel>Template</FieldLabel>
                    <select value={templateId} onChange={e => { setTemplateId(e.target.value); setSandbox(!!templates.find(t => t.id === e.target.value)?.sandbox) }} disabled={!isTauri} className="select-field" style={FIELD_STYLE}>
                      <option value="">None, configure manually</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name} · {t.mode === 'ephemeral' ? 'one-shot' : 'interactive'}</option>)}
                    </select>
                  </div>
                )}
                {/* worktree isolation is local-only */}
                {!machine && (
                  <Toggle
                    checked={isolate}
                    onChange={setIsolate}
                    disabled={!isTauri}
                    title="Isolate in a git worktree"
                    detail="Runs on a branch in a mirrored copy (multi-repo folders work too); review and merge when done."
                    tip="The working folder (a git repo, or a folder whose subfolders are repos) is mirrored into git worktrees on branch yaam/<session>; the session works there and your checkout stays untouched until you merge."
                  />
                )}
                {/* plain terminals spawn `shell -l -i` with no command string, so the
                    OS wrapper has nothing to wrap; the option only applies to commands */}
                {!(isShell && !tpl) && (
                  <Toggle
                    checked={sandbox}
                    onChange={setSandbox}
                    disabled={!isTauri}
                    title="Sandbox writes to the working folder"
                    detail="OS-enforced: writes limited to this folder, temp, and agent state dirs. If it can't be applied, the launch fails instead of running unprotected."
                    tip="sandbox-exec on macOS, bwrap on Linux, locally or on the remote host. The agent reads everything; network stays available. Templates can add writable paths or deny network."
                  />
                )}
                {sandboxNeedsCwd && (
                  <div role="alert" style={{ fontSize: 11, color: 'var(--amber)' }}>
                    Choose a specific working folder (not home or /) before launching a sandboxed session.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
          {/* detached = durable lifecycle: a tmux session on a machine, a setsid
              host process locally. Off = the session ends when you disconnect. */}
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none', fontSize: 12, color: 'var(--mut)', minWidth: 0 }}
            title={machine ? 'Runs the agent in a tmux session on the host; it keeps working after you disconnect or quit YAAM. Press ▶ to reattach; Stop ends the tmux session.' : "Runs in its own host process with its own lifecycle; it keeps working after you quit YAAM. Reopen the app and press ▶ to reattach; Stop ends it for real."}
          >
            <input type="checkbox" checked={detached} onChange={e => setDetached(e.target.checked)} disabled={!isTauri} />
            {machine ? 'Keep running in tmux' : 'Keep running after quit'}
          </label>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--faint)' }} className="mono">⌘↵</span>
          <button className="deny-btn" style={{ padding: '8px 16px' }} onClick={onClose}>Cancel</button>
          <button
            className="approve-btn"
            style={{ padding: '8px 18px', opacity: isTauri && canLaunch ? 1 : 0.45, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            onClick={() => launch()}
            disabled={!isTauri || !canLaunch}
            title={needsCwd ? 'Choose a folder first' : undefined}
          >
            Launch{tpl ? ` · ${tpl.name}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
