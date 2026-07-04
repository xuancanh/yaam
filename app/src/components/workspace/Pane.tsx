import { useState } from 'react'
import { useActions } from '../../store'
import { ACCENT, memTokens } from '../../data'
import type { Agent } from '../../types'
import { AgentAvatar, EditableName, IC, Icon, StatusPill } from '../ui'
import { FilesPane } from './FilesPane'
import { TerminalPane } from './TerminalPane'

// explorer visibility survives tab switches (panes remount freely)
const filesOpenCache = new Map<string, boolean>()

/** Render one terminal pane with session controls and optional file explorer. */
export function Pane({ agent, index, active, showRing, maximized }: { agent: Agent; index: number; active: boolean; showRing: boolean; maximized: boolean }) {
  const { setActivePane, closePane, openPanel, resume, approve, deny, stopSession, toggleMaximize, minimizePane, renameSession } = useActions()
  const [filesOpen, setFilesOpen] = useState(filesOpenCache.get(agent.id) ?? false)
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
        background: '#0A0B0F', boxShadow: showRing && active ? `inset 0 0 0 1.5px ${ACCENT}` : 'none',
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
            {agent.repo} · {agent.branch}
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
        <button className="icon-btn" title="Memory & context" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); openPanel(agent.id, 'memory') }}>
          <Icon paths={['M7 7h10v10H7z', ...IC.chip]} size={15} />
        </button>
        <button className="icon-btn" title="Tools & permissions" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); openPanel(agent.id, 'tools') }}>
          <Icon paths={[...IC.sliders, 'M6 9m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M12 15m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M18 7m-2 0a2 2 0 104 0 2 2 0 10-4 0']} size={15} />
        </button>
        {(agent.status === 'idle' || agent.status === 'error') && (
          <button className="icon-btn" title="Resume session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--green)' }} onClick={e => { e.stopPropagation(); resume(agent.id) }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
          </button>
        )}
        {agent.kind === 'real' && agent.status === 'running' && (
          <button className="icon-btn" title="Stop session" style={{ width: 27, height: 27, borderRadius: 7, color: 'var(--red-soft)' }} onClick={e => { e.stopPropagation(); stopSession(agent.id) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
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
        <button className="icon-btn danger" title="Close pane" style={{ width: 27, height: 27, borderRadius: 7 }} onClick={e => { e.stopPropagation(); closePane(index) }}>
          <Icon paths={IC.close} size={14} stroke={1.8} />
        </button>
      </div>

      {filesOpen ? <FilesPane agent={agent} active={active} /> : <TerminalPane agent={agent} active={active} />}

      {agent.status === 'needs' && (
        <div style={{
          borderTop: '1px solid rgba(255,176,32,.4)', background: 'rgba(255,176,32,.07)',
          padding: '12px 15px', display: 'flex', flexDirection: 'column', gap: 9,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)' }}>
            <Icon paths={IC.warn} size={15} stroke={1.8} />
            Blocked — waiting for your approval
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#C7CCD6' }}>{agent.escReason}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="approve-btn" style={{ padding: '7px 16px' }} onClick={e => { e.stopPropagation(); approve(agent.id) }}>Approve</button>
            <button className="deny-btn" style={{ padding: '7px 16px' }} onClick={e => { e.stopPropagation(); deny(agent.id) }}>Deny</button>
          </div>
        </div>
      )}

      <div className="mono" style={{
        height: 26, flexShrink: 0, background: 'var(--panel)', borderTop: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px', fontSize: 10.5, color: 'var(--dim)',
      }}>
        <span>{agent.model}</span>
        <span>{memOn.length} memories · {memTotal.toFixed(1)}k</span>
        <span>{toolCount} tools</span>
        {agent.cliSessionId && (
          <span title={`CLI session ${agent.cliSessionId} — used for resume`} style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
            ⧉ {agent.cliSessionId.slice(0, 8)}
          </span>
        )}
      </div>
    </div>
  )
}
