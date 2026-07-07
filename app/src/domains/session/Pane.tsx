import { useRef, useState } from 'react'
import { useActions } from '../../store'
import { ACCENT, memTokens } from '../../core/data'
import type { Agent } from '../../core/types'
import { AgentAvatar, EditableName, IC, Icon, StatusPill } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'
import { ChatPane } from '../chat/ChatPane'
import { FilesPane } from './FilesPane'
import { GitPanel } from './GitPanel'
import { TerminalPane } from './TerminalPane'

// explorer visibility survives tab switches (panes remount freely)
const filesOpenCache = new Map<string, boolean>()

/** Render one terminal pane with session controls and optional file explorer. */
export function Pane({ agent, index, active, showRing, maximized }: { agent: Agent; index: number; active: boolean; showRing: boolean; maximized: boolean }) {
  const { setActivePane, openPanel, resume, stopSession, toggleMaximize, minimizePane, renameSession, refreshTerminal, archiveSession } = useActions()
  const machineLabel = agent.machine ? (agent.machine.label || 'remote') : ''
  const [filesOpen, setFilesOpen] = useState(filesOpenCache.get(agent.id) ?? false)
  const [gitOpen, setGitOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // open the settings menu upward when a bottom-row pane lacks room below, so it
  // never renders off the bottom edge of the window
  const [settingsUp, setSettingsUp] = useState(false)
  const settingsAnchor = useRef<HTMLDivElement>(null)
  const toggleSettings = () => {
    setSettingsOpen(v => {
      if (!v) {
        const rect = settingsAnchor.current?.getBoundingClientRect()
        setSettingsUp(!!rect && window.innerHeight - rect.bottom < 150)
      }
      return !v
    })
  }
  // Toggle the pane-local file explorer and repaint the terminal after resizing.
  const toggleFiles = () => {
    setFilesOpen(v => {
      filesOpenCache.set(agent.id, !v)
      return !v
    })
  }
  const memOn = agent.memory.filter(m => m.on)
  const memTotal = memOn.reduce((n, m) => n + memTokens(agent, m.id), 0)
  const toolCount = agent.tools.filter(t => t.on).length

  return (
    <div
      onClick={() => setActivePane(index)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        background: 'var(--bg2)', boxShadow: showRing && active ? `inset 0 0 0 1.5px ${ACCENT}` : 'none',
        position: 'relative',
      }}
    >
      <div style={{
        height: 42, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 9, padding: '0 11px',
      }}>
        <AgentAvatar agent={agent} />
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <EditableName name={agent.name} onRename={name => renameSession(agent.id, name)} fontSize={12.5} />
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.repo} · {agent.branch}{machineLabel ? <span style={{ color: 'var(--accent)' }}> · {machineLabel}</span> : null}{agent.worktree ? <span style={{ color: 'var(--amber)' }}> · isolated</span> : null}{agent.detached ? <span style={{ color: 'var(--green)' }}> · detached</span> : null}
          </div>
        </div>
        <div style={{ marginLeft: 6 }}>
          <StatusPill agent={agent} />
        </div>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title={filesOpen ? 'Hide file explorer' : 'File explorer & viewer'}
          style={{ width: 27, height: 27, borderRadius: 7, color: filesOpen ? 'var(--accent)' : undefined }}
          onClick={e => { e.stopPropagation(); toggleFiles() }}
        >
          <Icon paths={['M3 7a2 2 0 012-2h4l2 2h9a1 1 0 011 1v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z']} size={15} stroke={1.6} />
        </button>
        {agent.kind !== 'chat' && agent.cwd && (
          <button
            className="icon-btn"
            title={agent.worktree ? 'Git — stage, commit, review & merge the worktree' : 'Git — stage, commit, review changes'}
            style={{ width: 27, height: 27, borderRadius: 7, color: agent.worktree ? 'var(--amber)' : undefined }}
            onClick={e => { e.stopPropagation(); setGitOpen(true) }}
          >
            <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={15} stroke={1.7} />
          </button>
        )}
        <div ref={settingsAnchor} style={{ position: 'relative' }}>
          <button
            className="icon-btn"
            title="Session settings — memory & context, tools & permissions"
            style={{ width: 27, height: 27, borderRadius: 7, color: settingsOpen ? 'var(--accent)' : undefined }}
            onClick={e => { e.stopPropagation(); toggleSettings() }}
          >
            <Icon paths={[...IC.sliders, 'M6 9m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M12 15m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M18 7m-2 0a2 2 0 104 0 2 2 0 10-4 0']} size={15} />
          </button>
          {settingsOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={e => { e.stopPropagation(); setSettingsOpen(false) }} />
              <div style={{
                position: 'absolute', ...(settingsUp ? { bottom: 31 } : { top: 31 }), right: 0, zIndex: 41, minWidth: 190,
                background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 10,
                padding: 4, boxShadow: '0 8px 28px rgba(0,0,0,.35)',
              }}>
                <button
                  className="palette-item"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, border: 'none', textAlign: 'left', padding: '7px 10px', borderRadius: 7, fontSize: 12, color: 'var(--text)' }}
                  onClick={e => { e.stopPropagation(); setSettingsOpen(false); openPanel(agent.id, 'memory') }}
                >
                  <Icon paths={['M7 7h10v10H7z', ...IC.chip]} size={14} />
                  Memory & context
                </button>
                <button
                  className="palette-item"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, border: 'none', textAlign: 'left', padding: '7px 10px', borderRadius: 7, fontSize: 12, color: 'var(--text)' }}
                  onClick={e => { e.stopPropagation(); setSettingsOpen(false); openPanel(agent.id, 'tools') }}
                >
                  <Icon paths={[...IC.sliders, 'M6 9m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M12 15m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M18 7m-2 0a2 2 0 104 0 2 2 0 10-4 0']} size={14} />
                  Tools & permissions
                </button>
              </div>
            </>
          )}
        </div>
        {agent.kind !== 'chat' && (agent.status === 'idle' || agent.status === 'error') && (
          <button className="icon-btn" title="Resume session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--green)' }} onClick={e => { e.stopPropagation(); resume(agent.id) }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
          </button>
        )}
        {agent.kind === 'real' && agent.status === 'running' && (
          <button className="icon-btn" title="Stop session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--red-soft)' }} onClick={e => { e.stopPropagation(); stopSession(agent.id) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        )}
        {agent.kind !== 'chat' && (
          <button
            className="icon-btn"
            title="Clear terminal — full reset of the display and scrollback (fixes a corrupted pane; a live TUI repaints with Ctrl+L)"
            style={{ width: 27, height: 27, borderRadius: 7 }}
            onClick={e => { e.stopPropagation(); refreshTerminal(agent.id) }}
          >
            <Icon paths={['M21 12a9 9 0 11-2.6-6.4', 'M21 4v5h-5']} size={13} stroke={1.8} />
          </button>
        )}
        <button className="icon-btn" title="Minimize to dock" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); minimizePane(index) }}>
          <Icon paths={['M5 19h14']} size={14} stroke={1.8} />
        </button>
        <button className="icon-btn" title={maximized ? 'Restore grid' : 'Maximize pane'} style={{ width: 27, height: 27, borderRadius: 7, color: maximized ? 'var(--accent)' : undefined }} onClick={e => { e.stopPropagation(); toggleMaximize(index) }}>
          {maximized
            ? <Icon paths={['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5']} size={14} stroke={1.8} />
            : <Icon paths={['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']} size={14} stroke={1.8} />}
        </button>
        <button
          className="icon-btn danger"
          title="Close session — stops the process and archives it (recoverable from Archived)"
          style={{ width: 27, height: 27, borderRadius: 7 }}
          onClick={e => {
            e.stopPropagation()
            const running = agent.status === 'running' || agent.status === 'needs'
            void confirmAction({
              title: `Close “${agent.name}”?`,
              detail: running
                ? 'The running process will be stopped and the session archived. You can restore it from the Archived list in Agents.'
                : 'The session will be archived. You can restore it from the Archived list in Agents.',
              confirmLabel: running ? 'Stop & archive' : 'Archive',
              danger: running,
            }).then(ok => { if (ok) archiveSession(agent.id) })
          }}
        >
          <Icon paths={IC.close} size={14} stroke={1.8} />
        </button>
      </div>

      {filesOpen
        ? <FilesPane agent={agent} active={active} />
        : agent.kind === 'chat'
          ? <ChatPane agent={agent} active={active} />
          : <TerminalPane agent={agent} active={active} />}

      {gitOpen && <GitPanel agent={agent} onClose={() => setGitOpen(false)} />}

      <div className="mono" style={{
        height: 26, flexShrink: 0, background: 'var(--panel)', borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', fontSize: 10.5, color: 'var(--dim)',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.model}</span>
        <span style={{ flexShrink: 0 }}>{memOn.length} memories · {memTotal.toFixed(1)}k</span>
        <span style={{ flexShrink: 0 }}>{toolCount} tools</span>
        {agent.cliSessionId && (
          <span title={`CLI session ${agent.cliSessionId} — used for resume`} style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
            ⧉ {agent.cliSessionId.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  )
}
