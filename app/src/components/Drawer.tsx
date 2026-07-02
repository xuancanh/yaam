import { useEffect, useState } from 'react'
import { useActions, useConductor } from '../store'
import { DIFF_BG, DIFF_COLORS, LOG_COLORS } from '../data'
import { gitDiff, isTauri } from '../native'
import type { Agent, DiffFile } from '../types'
import { AgentAvatar, EditableName, IC, Icon } from './ui'

/** Parse `git diff` unified output into per-file hunk lists (capped for display). */
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

function DiffBody({ agent }: { agent: Agent }) {
  const { approveDiff, requestChanges } = useActions()
  const canFetch = isTauri && agent.kind === 'real' && !!agent.cwd
  const [files, setFiles] = useState<DiffFile[]>(agent.diff)
  const [status, setStatus] = useState(canFetch ? 'loading…' : '')

  useEffect(() => {
    if (!canFetch) return
    let alive = true
    gitDiff(agent.cwd!).then(raw => {
      if (!alive) return
      const parsed = parseUnifiedDiff(raw)
      setFiles(parsed)
      setStatus(parsed.length ? '' : 'working tree clean — no uncommitted changes')
    }).catch(e => {
      if (alive) setStatus(String(e))
    })
    return () => { alive = false }
  }, [agent.cwd, agent.id, canFetch])

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
              <span className="mono" style={{ fontSize: 12, color: '#C7CCD6', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</span>
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
      <div style={{ borderTop: '1px solid var(--line)', padding: '13px 18px', display: 'flex', gap: 10 }}>
        <button className="approve-btn" style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => approveDiff(agent.id)}>
          Approve &amp; merge
        </button>
        <button className="deny-btn" style={{ flex: 1, padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => requestChanges(agent.id)}>
          Request changes
        </button>
      </div>
    </>
  )
}

function AgentBody({ agent }: { agent: Agent }) {
  const { closeDrawer, focusTab, resume } = useActions()
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
        <div className="mono" style={{ background: 'var(--bg)', border: '1px solid #1a1e26', borderRadius: 11, padding: '12px 14px', fontSize: 12, lineHeight: 1.6 }}>
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
        {agent.status === 'idle' && (
          <button className="resume-btn" style={{ padding: 10, fontSize: 13, borderRadius: 9 }} onClick={() => { closeDrawer(); resume(agent.id) }}>
            Resume session
          </button>
        )}
      </div>
    </>
  )
}

export function Drawer() {
  const s = useConductor()
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
