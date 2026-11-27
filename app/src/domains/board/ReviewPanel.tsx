import { memo, useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector } from '../../store'
import { worktreeDiff } from '../../core/native'
import { multiRepoDiff } from '../../shared/git-repos'
import type { BoardTask } from '../../core/types'
import { IC, Icon } from '../../components/ui'

// Review queue: the modal behind a review-column card. Shows what the task
// actually changed — per-repo worktree diffs for isolated tasks, or the
// working-tree diff of the task folder otherwise — and closes the loop:
// Approve merges the worktree back (and cleans it up) before moving the card
// to done; Request changes bounces it to progress with the reviewer's comment
// as the watcher's next instruction.

// A lockfile or generated-code diff can run to tens of thousands of lines; one
// div per line for all of it froze the panel. Render a bounded head, with the
// rest one click away.
const DIFF_LINES_SHOWN = 4000

/** One unified-diff, colored by line kind. Memoized: typing a review comment
 *  re-renders the panel, not the diff. */
const DiffText = memo(function DiffText({ diff }: { diff: string }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => diff.split('\n'), [diff])
  if (!diff.trim()) return <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--dim)' }}>no changes</div>
  const shown = all ? lines : lines.slice(0, DIFF_LINES_SHOWN)
  return (
    <pre className="mono" style={{ margin: 0, padding: '8px 0', fontSize: 11.5, lineHeight: 1.55, overflowX: 'auto' }}>
      {shown.map((line, i) => {
        const color = line.startsWith('+++') || line.startsWith('---') ? 'var(--text)'
          : line.startsWith('+') ? 'var(--green)'
          : line.startsWith('-') ? 'var(--red-soft)'
          : line.startsWith('@@') ? 'var(--accent)'
          : line.startsWith('diff --git') ? 'var(--text)'
          : 'var(--mut)'
        const bg = line.startsWith('diff --git') ? 'var(--panel2)'
          : line.startsWith('+') && !line.startsWith('+++') ? 'rgba(61,220,151,.06)'
          : line.startsWith('-') && !line.startsWith('---') ? 'rgba(255,92,92,.06)'
          : 'transparent'
        return (
          <div key={i} style={{ padding: '0 14px', color, background: bg, fontWeight: line.startsWith('diff --git') ? 700 : 400, whiteSpace: 'pre' }}>
            {line || ' '}
          </div>
        )
      })}
      {shown.length < lines.length && (
        <button className="btn ghost" style={{ margin: '8px 14px' }} onClick={() => setAll(true)}>
          Show the remaining {lines.length - shown.length} lines
        </button>
      )}
    </pre>
  )
})

interface RepoDiffView {
  name: string
  diff: string
  error?: string | null
}

export function ReviewPanel({ task, onClose }: { task: BoardTask; onClose: () => void }) {
  // just the worktree root, not the whole agents array (which changes on
  // every output flush)
  const worktreeRoot = useConductorSelector(x => (task.agentIds ?? [])
    .map(aid => x.agents.find(a => a.id === aid)?.worktree?.root)
    .find(Boolean))
  const { approveTaskReview, rejectTaskReview } = useActions()
  const [diffs, setDiffs] = useState<RepoDiffView[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [mergeErr, setMergeErr] = useState<string | null>(null)


  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        if (worktreeRoot) {
          const res = await worktreeDiff(worktreeRoot)
          if (live) setDiffs(res)
        } else if (task.cwd) {
          // the task folder may itself be a folder of repos — diff each one
          const repos = await multiRepoDiff(task.cwd)
          if (live) setDiffs(repos.map(r => ({ name: r.name || task.cwd!, diff: r.diff })))
        } else {
          if (live) setLoadErr('This task has no worktree and no working folder — nothing to diff.')
        }
      } catch (e) {
        if (live) setLoadErr(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id])

  const approve = async () => {
    setBusy(true)
    setMergeErr(null)
    const err = await approveTaskReview(task.id)
    setBusy(false)
    if (err) setMergeErr(err)
    else onClose()
  }

  const reject = () => {
    rejectTaskReview(task.id, comment)
    onClose()
  }

  const changedFiles = useMemo(() => (diffs ?? []).reduce((n, d) => n + (d.diff.match(/^diff --git /gm)?.length ?? 0), 0), [diffs])

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '5vh 4vw' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 940, maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column',
          background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: '#FFB020', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="grotesk" style={{ fontSize: 14.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Review · {task.title}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
              {worktreeRoot ? `worktree ${worktreeRoot}` : task.cwd ? `working tree ${task.cwd}` : 'no folder'}
              {diffs ? ` · ${changedFiles} file${changedFiles === 1 ? '' : 's'} changed` : ''}
            </div>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose} style={{ width: 26, height: 26 }}>
            <Icon paths={IC.close} size={12} stroke={2} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--bg3)' }}>
          {loadErr ? (
            <div style={{ padding: 18, fontSize: 12.5, color: 'var(--red-soft)' }}>{loadErr}</div>
          ) : diffs === null ? (
            <div style={{ padding: 18, fontSize: 12.5, color: 'var(--dim)' }}>Loading diff…</div>
          ) : diffs.map(d => (
            <div key={d.name}>
              {diffs.length > 1 && (
                <div className="mono" style={{ padding: '8px 14px', fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
                  ▸ {d.name}
                </div>
              )}
              {d.error
                ? <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--red-soft)' }}>{d.error}</div>
                : <DiffText diff={d.diff} />}
            </div>
          ))}
        </div>

        {mergeErr && (
          <div className="mono" style={{ padding: '9px 16px', fontSize: 11, color: 'var(--red-soft)', borderTop: '1px solid var(--line)', whiteSpace: 'pre-wrap', maxHeight: 110, overflowY: 'auto' }}>
            {mergeErr}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder="Feedback for “Request changes” — sent to the task's watcher…"
            rows={2}
            style={{
              flex: 1, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
              padding: '8px 11px', color: 'var(--text)', outline: 'none', fontSize: 12.5, resize: 'vertical',
              fontFamily: 'var(--font-sans)',
            }}
          />
          <button className="deny-btn" style={{ padding: '9px 16px', flexShrink: 0 }} onClick={reject} disabled={busy}>
            Request changes
          </button>
          <button
            className="approve-btn"
            style={{ padding: '9px 18px', flexShrink: 0, opacity: busy ? 0.6 : 1 }}
            onClick={() => { void approve() }}
            disabled={busy}
            title={worktreeRoot ? 'Commit + merge each repo back into its original checkout, then move to done' : 'Move to done (changes were made in place)'}
          >
            {busy ? 'Merging…' : worktreeRoot ? 'Approve & merge' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  )
}
