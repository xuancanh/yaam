import { useState } from 'react'
import { useActions } from '../../store'
import type { Agent } from '../../core/types'
import { confirmAction } from '../../components/Confirm'

// The redesigned review→merge closer for worktree-isolated sessions, rendered
// as a GitWorkbench footer (pane Changes panel, Mission Control's Changes
// tab). One bar: where the merge lands, an editable commit message for the
// merge-back commit, Merge (per-repo results surface inline on failure — a
// conflict in one repo of a multi-repo mirror leaves the rest merged), and
// Discard for abandoning the attempt without touching the original checkout.

export function WorktreeMergeBar({ agent, onDone }: { agent: Agent; onDone?: () => void }) {
  const { mergeSessionWorktree, discardSessionWorktree } = useActions()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'merge' | 'discard' | null>(null)
  const [err, setErr] = useState('')
  const wt = agent.worktree
  if (!wt) return null

  const merge = async () => {
    setBusy('merge')
    setErr('')
    const e = await mergeSessionWorktree(agent.id, message)
    setBusy(null)
    if (e) setErr(e)
    else onDone?.()
  }

  const discard = async () => {
    const ok = await confirmAction({
      title: 'Discard this worktree?',
      detail: 'All of the session\'s isolated changes are dropped — nothing is merged back. This cannot be undone.',
      confirmLabel: 'Discard changes',
    })
    if (!ok) return
    setBusy('discard')
    setErr('')
    const e = await discardSessionWorktree(agent.id)
    setBusy(null)
    if (e) setErr(e)
    else onDone?.()
  }

  return (
    <div style={{ borderTop: '1px solid var(--line)', flexShrink: 0 }}>
      {err && (
        <div className="mono" style={{ padding: '8px 14px', fontSize: 11, color: 'var(--red-soft)', whiteSpace: 'pre-wrap', maxHeight: 96, overflowY: 'auto', borderBottom: '1px solid var(--line)' }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px' }}>
        <span className="mono" title={`merges back into ${wt.base}`} style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--amber)' }}>
          ⑂ → {wt.base.slice(wt.base.lastIndexOf('/') + 1) || wt.base}
        </span>
        <input
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder={`merge commit message · default “yaam: ${agent.name.slice(0, 40)}”`}
          style={{
            flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
            padding: '6px 9px', color: 'var(--text)', outline: 'none', fontSize: 11.5, fontFamily: 'var(--font-sans)',
          }}
        />
        <button
          className="deny-btn"
          style={{ flexShrink: 0, padding: '7px 12px', fontSize: 11.5 }}
          disabled={!!busy}
          title="Drop the worktree without merging — the changes are lost"
          onClick={() => { void discard() }}
        >
          {busy === 'discard' ? 'Discarding…' : 'Discard'}
        </button>
        <button
          className="approve-btn"
          style={{ flexShrink: 0, padding: '7px 16px', fontSize: 11.5, opacity: busy ? 0.6 : 1 }}
          disabled={!!busy}
          title={`Commit + merge each repo's yaam branch back into ${wt.base}, then remove the mirror`}
          onClick={() => { void merge() }}
        >
          {busy === 'merge' ? 'Merging…' : 'Merge back'}
        </button>
      </div>
    </div>
  )
}
