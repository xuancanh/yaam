import { useEffect, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { DIFF_BG, DIFF_COLORS, LOG_COLORS } from '../../core/data'
import { isTauri, worktreeDiff } from '../../core/native'
import { multiRepoDiff } from '../../shared/git-repos'
import type { Agent, DiffFile } from '../../core/types'
import { AgentAvatar, EditableName, IC, Icon } from '../../components/ui'

/** Parse `git diff` unified output into per-file hunk lists (capped for display). */
/** Convert a unified git diff into the drawer's per-file line model. */
function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/ b\/(.+)$/)
      current = { file: m ? m[1] : line.slice(11), add: 0, del: 0, hunks: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('new file') || line.startsWith('deleted file')) continue
    if (current.hunks.length >= 160) continue
    if (line.startsWith('@@')) current.hunks.push({ t: 'meta', x: line })
    else if (line.startsWith('+')) { current.add += 1; current.hunks.push({ t: 'add', x: line }) }
    else if (line.startsWith('-')) { current.del += 1; current.hunks.push({ t: 'del', x: line }) }
    else current.hunks.push({ t: 'ctx', x: line })
  }
  return files
}

/** Load and render the selected session's diff: worktree sessions diff every
 *  mirrored repo against its fork point; plain sessions show the working tree. */
function DiffBody({ agent }: { agent: Agent }) {
  const { approveDiff, requestChanges, mergeSessionWorktree, closeDrawer } = useActions()
  const canFetch = isTauri && !!agent.cwd && (agent.kind === 'real' || !!agent.worktree)
  const [files, setFiles] = useState<DiffFile[]>(agent.diff)
  const [status, setStatus] = useState(canFetch ? 'loading…' : '')
  const [merging, setMerging] = useState(false)
  const [mergeErr, setMergeErr] = useState('')

  useEffect(() => {
    if (!canFetch) return
    let alive = true
    const load = async (): Promise<DiffFile[]> => {
      if (agent.worktree) {
        const repos = await worktreeDiff(agent.worktree.root)
        return repos.flatMap(r => parseUnifiedDiff(r.diff).map(f =>
          repos.length > 1 ? { ...f, file: `${r.name}/${f.file}` } : f))
      }
      // plain sessions: the cwd may itself be a folder of repos
      const repos = await multiRepoDiff(agent.cwd!)
      return repos.flatMap(r => parseUnifiedDiff(r.diff).map(f =>
        r.name ? { ...f, file: `${r.name}/${f.file}` } : f))
    }
    load().then(parsed => {
      if (!alive) return
      setFiles(parsed)
      setStatus(parsed.length ? '' : agent.worktree ? 'worktree matches its fork point — no changes yet' : 'working tree clean — no uncommitted changes')
    }).catch(e => {
      if (alive) setStatus(String(e))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.cwd, agent.id, agent.worktree?.root, canFetch])

  const mergeWorktree = async () => {
    setMerging(true)
    setMergeErr('')
    const err = await mergeSessionWorktree(agent.id)
    setMerging(false)
    if (err) setMergeErr(err)
    else closeDrawer()
  }

  const totalAdd = files.reduce((n, f) => n + f.add, 0)
  const totalDel = files.reduce((n, f) => n + f.del, 0)

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, fontSize: 12, color: 'var(--mut)' }}>
          <span>{files.length} files changed{canFetch ? ' · live git diff' : ''}</span>
          <span className="mono" style={{ color: '#7FE3B0', fontWeight: 600 }}>+{totalAdd}</span>
          <span className="mono" style={{ color: '#FF9B9B', fontWeight: 600 }}>−{totalDel}</span>
        </div>
        {status && <div className="mono" style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 14 }}>{status}</div>}
        {files.map(f => (
          <div key={f.file} style={{ border: '1px solid var(--line)', borderRadius: 11, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
              <span className="mono" style={{ fontSize: 12, color: 'var(--text2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</span>
              <span className="mono" style={{ fontSize: 11, color: '#7FE3B0', fontWeight: 600 }}>+{f.add}</span>
              <span className="mono" style={{ fontSize: 11, color: '#FF9B9B', fontWeight: 600 }}>−{f.del}</span>
            </div>
            <div className="mono" style={{ background: 'var(--bg)', padding: '8px 0', fontSize: 12, lineHeight: 1.6 }}>
              {f.hunks.map((h, i) => (
                <div key={i} style={{
                  padding: '0 13px', color: DIFF_COLORS[h.t] || 'var(--mut)', background: DIFF_BG[h.t] || 'transparent',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {h.x}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {mergeErr && (
        <div className="mono" style={{ borderTop: '1px solid var(--line)', padding: '9px 18px', fontSize: 11, color: 'var(--red-soft)', whiteSpace: 'pre-wrap', maxHeight: 110, overflowY: 'auto' }}>
          {mergeErr}
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
            Approve &amp; merge
          </button>
        )}
        <button className="deny-btn" style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => requestChanges(agent.id)}>
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
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 520, maxWidth: '92vw', background: 'var(--panel)',
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
        {isDiff ? <DiffBody agent={agent} /> : <AgentBody agent={agent} />}
      </div>
    </>
  )
}
