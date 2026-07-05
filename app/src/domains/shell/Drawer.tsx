import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { LOG_COLORS } from '../../core/data'
import type { Agent } from '../../core/types'
import { AgentAvatar, EditableName, IC, Icon } from '../../components/ui'
import { GitWorkbench } from '../session/GitPanel'

/** Review actions under the shared git workbench: a feedback chatbox that
 *  types straight into the session's terminal, worktree merge-back (real git)
 *  or plain approve, and request-changes (which also forwards the feedback). */
function ReviewFooter({ agent }: { agent: Agent }) {
  const { approveDiff, requestChanges, mergeSessionWorktree, closeDrawer, sendInput } = useActions()
  const [merging, setMerging] = useState(false)
  const [mergeErr, setMergeErr] = useState('')
  const [feedback, setFeedback] = useState('')
  const [sent, setSent] = useState(false)
  const canSend = agent.kind === 'real' && !agent.archived

  const sendFeedback = () => {
    const msg = feedback.trim()
    if (!msg || !canSend) return
    sendInput(agent.id, msg)
    setFeedback('')
    setSent(true)
    window.setTimeout(() => setSent(false), 2000)
  }

  const mergeWorktree = async () => {
    setMerging(true)
    setMergeErr('')
    const err = await mergeSessionWorktree(agent.id)
    setMerging(false)
    if (err) setMergeErr(err)
    else closeDrawer()
  }

  return (
    <>
      {mergeErr && (
        <div className="mono" style={{ borderTop: '1px solid var(--line)', padding: '9px 18px', fontSize: 11, color: 'var(--red-soft)', whiteSpace: 'pre-wrap', maxHeight: 110, overflowY: 'auto' }}>
          {mergeErr}
        </div>
      )}
      {canSend && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '10px 18px', display: 'flex', gap: 8 }}>
          <input
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') sendFeedback() }}
            placeholder={sent ? 'sent to the terminal ✓' : 'Feedback for the agent — types into its terminal… (↩ send)'}
            style={{
              flex: 1, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
              padding: '8px 11px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
              fontFamily: 'var(--font-sans)',
            }}
          />
          <button
            className="open-btn"
            style={{ flex: 'none', padding: '0 14px', fontSize: 12, opacity: feedback.trim() ? 1 : 0.5 }}
            disabled={!feedback.trim()}
            onClick={sendFeedback}
          >
            Send
          </button>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--line)', padding: '13px 18px', display: 'flex', gap: 10 }}>
        {agent.worktree ? (
          <button
            className="approve-btn"
            style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9, opacity: merging ? 0.6 : 1 }}
            disabled={merging}
            title={`Commit + merge each repo's yaam branch back into ${agent.worktree.base}, then remove the mirror`}
            onClick={() => { void mergeWorktree() }}
          >
            {merging ? 'Merging…' : 'Approve & merge worktree'}
          </button>
        ) : (
          <button className="approve-btn" style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => approveDiff(agent.id)}>
            Approve
          </button>
        )}
        <button
          className="deny-btn"
          style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9 }}
          title={feedback.trim() ? 'Also sends your feedback to the terminal' : undefined}
          onClick={() => { if (feedback.trim()) sendFeedback(); requestChanges(agent.id) }}
        >
          Request changes
        </button>
      </div>
    </>
  )
}

/** Render session details, monitor state, tools, memory, and lifecycle actions. */
function AgentBody({ agent }: { agent: Agent }) {
  const { closeDrawer, focusTab, resume, archiveSession, deleteSession } = useActions()
  const history = agent.log.slice(-16)

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 11, padding: 13 }}>
            <div style={{ fontSize: 11, color: 'var(--mut)' }}>Spend</div>
            <div className="grotesk" style={{ fontSize: 20, fontWeight: 600, marginTop: 3 }}>${agent.cost.toFixed(2)}</div>
          </div>
          <div style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 11, padding: 13 }}>
            <div style={{ fontSize: 11, color: 'var(--mut)' }}>Tokens</div>
            <div className="grotesk" style={{ fontSize: 20, fontWeight: 600, marginTop: 3 }}>{agent.used.toFixed(1)}k</div>
          </div>
        </div>
        {agent.cliSessionId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 11, padding: '11px 13px', marginBottom: 20 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--mut)' }}>CLI session id · used by resume</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.cliSessionId}</div>
            </div>
          </div>
        )}
        <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--mut)', marginBottom: 10 }}>RESUME POINTS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {agent.snaps.map((sn, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8B93A1" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" />
              </svg>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text)' }}>{sn.label}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{sn.time}</span>
            </div>
          ))}
        </div>
        <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--mut)', marginBottom: 10 }}>SESSION HISTORY</div>
        <div className="mono" style={{ background: 'var(--bg)', border: '1px solid var(--line-soft)', borderRadius: 11, padding: '12px 14px', fontSize: 12, lineHeight: 1.6 }}>
          {history.map((line, i) => (
            <div key={i} style={{
              color: LOG_COLORS[line.t] || 'var(--mut)', fontStyle: line.t === 'think' ? 'italic' : 'normal',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>
              {line.x}
            </div>
          ))}
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: '13px 18px', display: 'flex', gap: 10 }}>
        <button className="open-btn" style={{ padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => { closeDrawer(); focusTab(agent.id) }}>
          Open in workspace
        </button>
        {agent.status === 'idle' && !agent.archived && (
          <button className="resume-btn" style={{ padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => { closeDrawer(); resume(agent.id) }}>
            Resume session
          </button>
        )}
        <button className="deny-btn" style={{ padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => archiveSession(agent.id)}>
          Archive
        </button>
        <button
          className="deny-btn"
          style={{ padding: 10, fontSize: 13, borderRadius: 9, color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
          onClick={() => deleteSession(agent.id)}
        >
          Delete
        </button>
      </div>
    </>
  )
}

/** Render the store-selected agent drawer and close it on backdrop interaction. */
export function Drawer() {
  const s = useConductorSelector(x => ({ agents: x.agents, drawer: x.drawer }), shallowEqual)
  const { closeDrawer, renameSession } = useActions()

  if (!s.drawer) return null
  const agent = s.agents.find(a => a.id === s.drawer!.agentId)
  if (!agent) return null
  const isDiff = s.drawer.kind === 'diff'

  return (
    <>
      <div onClick={closeDrawer} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 42 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: isDiff ? 960 : 520, maxWidth: '94vw', background: 'var(--panel)',
        borderLeft: '1px solid var(--line2)', zIndex: 43, display: 'flex', flexDirection: 'column',
        boxShadow: '-24px 0 60px rgba(0,0,0,.5)', animation: 'cslide .22s ease-out both',
      }}>
        <div style={{ padding: '15px 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 11 }}>
          <AgentAvatar agent={agent} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600 }}>
              <span style={{ flexShrink: 0 }}>{isDiff ? 'Review changes' : 'Session detail'} ·</span>
              <EditableName name={agent.name} onRename={name => renameSession(agent.id, name)} fontSize={14} />
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{agent.repo} · {agent.branch}</div>
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28, borderRadius: 7 }} onClick={closeDrawer}>
            <Icon paths={IC.close} size={15} stroke={1.8} />
          </button>
        </div>
        {isDiff
          ? <GitWorkbench cwd={agent.cwd} worktree={agent.worktree} footer={<ReviewFooter agent={agent} />} />
          : <AgentBody agent={agent} />}
      </div>
    </>
  )
}
