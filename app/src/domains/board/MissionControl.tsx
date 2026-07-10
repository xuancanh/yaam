import { useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { indicatorColor } from '../../core/data'
import type { Agent, BoardTask } from '../../core/types'
import { Icon } from '../../components/ui'
import { TerminalPane } from '../session/TerminalPane'
import { GitPopup, GitWorkbench } from '../session/GitPanel'
import { sessionFs } from '../session/remote-native'
import { WorktreeMergeBar } from '../session/WorktreeMergeBar'
import { useDiffStats } from '../session/diff-stats'
import { groupRuns, runStatusLabel } from './mission-state'
import type { RunFilter, RunRef } from './mission-state'
import { TaskReviewFooter, WatcherChat } from './WatcherChat'

// Mission Control: the board's triage mode (toggle in the board header).
// Conductor-style single view — every run (task sessions + loose sessions) in
// one urgency-grouped list on the left with live diff stats; the selected
// run's terminal, watcher chat, and changes (diff → stage → commit → merge)
// on the right, so review & merge never needs a view switch. ⌘1–9 jumps runs.

const TONE: Record<string, string> = {
  amber: 'var(--amber)', green: 'var(--green)', red: 'var(--red-soft)', mut: 'var(--dim)',
}

function runTitle(run: RunRef): string {
  return run.kind === 'task' ? run.task.title : run.agent.name
}

/** One selectable run row: status dot, title, chip, live diff stats, and an
 *  inline start for unstarted tasks (backlog). */
function RunRow({ run, stats, selected, shortcut, onSelect }: {
  run: RunRef
  stats?: { add: number; del: number; files: number }
  selected: boolean
  shortcut?: number
  onSelect: () => void
}) {
  const { startTask } = useActions()
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  const st = runStatusLabel(run)
  const flash = st.tone === 'amber'
  const startable = !!task && !agent && task.col !== 'done' && task.col !== 'failed'
  return (
    <button
      className="palette-item"
      onClick={onSelect}
      style={{
        width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 10px', textAlign: 'left',
        background: selected ? 'rgba(245,196,81,.09)' : 'transparent', border: 'none',
        borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`, borderRadius: 8, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%' }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: agent ? indicatorColor(agent) : 'var(--dim)',
          animation: flash ? 'cpulse 1.1s ease-in-out infinite' : 'none',
        }} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: selected ? 'var(--text)' : 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {runTitle(run)}
        </span>
        {startable && (
          <span
            role="button"
            title="Start a session for this task"
            onClick={e => { e.stopPropagation(); startTask(task.id) }}
            style={{ display: 'flex', alignItems: 'center', color: 'var(--green)', flexShrink: 0, padding: '0 2px' }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
          </span>
        )}
        {shortcut != null && <span className="mono" style={{ fontSize: 9, color: 'var(--faint)', flexShrink: 0 }}>⌘{shortcut}</span>}
      </div>
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 10, paddingLeft: 15 }}>
        <span style={{ color: TONE[st.tone] }}>{st.label}</span>
        {agent?.machine && <span style={{ color: 'var(--accent)' }}>⧉ {agent.machine.label || 'remote'}</span>}
        {agent?.worktree && <span style={{ color: 'var(--amber)' }}>⑂</span>}
        {stats && stats.files > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--dim)', flexShrink: 0 }}>
            <span style={{ color: 'var(--green)' }}>+{stats.add}</span> <span style={{ color: 'var(--red-soft)' }}>−{stats.del}</span> · {stats.files}
          </span>
        )}
      </div>
    </button>
  )
}

/** Task spec summary for runs without a live session (or as Watcher header). */
function SpecBlock({ task }: { task: BoardTask }) {
  const { startTask } = useActions()
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
        {task.description || <span style={{ color: 'var(--dim)' }}>No description.</span>}
      </div>
      {(task.criteria ?? []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          {(task.criteria ?? []).map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 7, fontSize: 12, color: 'var(--mut)', lineHeight: 1.6 }}>
              <span style={{ color: 'var(--accent)' }}>◇</span>{c}
            </div>
          ))}
        </div>
      )}
      {!task.agentId && task.col !== 'done' && (
        <button className="approve-btn" style={{ marginTop: 16, padding: '8px 20px', fontSize: 12.5 }} onClick={() => startTask(task.id)}>
          ▶ Start session
        </button>
      )}
    </div>
  )
}

/** per-run panel layout, remembered across selection changes */
const detailCache = new Map<string, { changes: boolean; watcher: boolean; dock: 'right' | 'bottom' }>()

/** Slim panel header strip: label + host-supplied controls, matching the
 *  session pane's Changes strip. */
function PanelStrip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, padding: '0 8px', borderBottom: '1px solid var(--line)' }}>
      <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--dim)' }}>{label}</span>
      <div style={{ flex: 1 }} />
      {children}
    </div>
  )
}

/** Right side: session-pane-style cockpit — the terminal (or spec) always in
 *  the center, with Changes and the task's Watcher chat as toggleable docked
 *  panels instead of tabs. The watcher lands in the bottom-right quarter. */
function RunDetail({ run }: { run: RunRef }) {
  const { focusTab } = useActions()
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  const inReview = task?.col === 'review'
  const cached = detailCache.get(run.key)
  // land open on what the run most likely needs: review → changes; a task
  // that is talking to (or waiting on) the user → its watcher chat
  const [changesOpen, setChangesOpen] = useState(cached?.changes ?? !!inReview)
  const [watcherOpen, setWatcherOpen] = useState(cached?.watcher ?? !!(task && (task.awaitingUser || (task.chat ?? []).some(m => m.role !== 'system'))))
  const [changesDock, setChangesDock] = useState<'right' | 'bottom'>(cached?.dock ?? 'right')
  const [popup, setPopup] = useState(false)
  useEffect(() => {
    const c = detailCache.get(run.key)
    setChangesOpen(c?.changes ?? (run.kind === 'task' && run.task.col === 'review'))
    setWatcherOpen(c?.watcher ?? (run.kind === 'task' && !!(run.task.awaitingUser || (run.task.chat ?? []).some(m => m.role !== 'system'))))
    setChangesDock(c?.dock ?? 'right')
    setPopup(false)
    // defaults are a snapshot at selection time — live task updates must not
    // reopen/close panels the user just toggled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.key])
  const remember = (patch: Partial<{ changes: boolean; watcher: boolean; dock: 'right' | 'bottom' }>) => {
    detailCache.set(run.key, { changes: changesOpen, watcher: watcherOpen, dock: changesDock, ...patch })
  }

  const cwd = agent?.worktree?.workdir ?? agent?.cwd ?? task?.cwd
  const fs = useMemo(() => sessionFs(agent?.machine, agent?.id ?? ''), [agent?.machine, agent?.id])

  const showChanges = changesOpen && !!cwd
  const showWatcher = watcherOpen && !!task
  const changesRight = showChanges && changesDock === 'right'
  const rightColOpen = changesRight || showWatcher

  const workbench = showChanges && (
    <GitWorkbench
      key={run.key}
      cwd={agent?.cwd ?? task?.cwd}
      worktree={agent?.worktree}
      fs={fs}
      compact={changesRight}
      footer={
        task && inReview
          ? <TaskReviewFooter task={task} onClose={() => {}} />
          : agent?.worktree
            ? <WorktreeMergeBar agent={agent} />
            : undefined
      }
    />
  )
  const changesStrip = (
    <PanelStrip label="CHANGES">
      <button
        className="icon-btn"
        title="Dock to the right"
        style={{ width: 22, height: 22, borderRadius: 6, color: changesDock === 'right' ? 'var(--accent)' : undefined }}
        onClick={() => { setChangesDock('right'); remember({ dock: 'right' }) }}
      >
        <Icon paths={['M4 5h16v14H4z', 'M14 5v14']} size={12} stroke={1.7} />
      </button>
      <button
        className="icon-btn"
        title="Dock below the terminal (full width)"
        style={{ width: 22, height: 22, borderRadius: 6, color: changesDock === 'bottom' ? 'var(--accent)' : undefined }}
        onClick={() => { setChangesDock('bottom'); remember({ dock: 'bottom' }) }}
      >
        <Icon paths={['M4 5h16v14H4z', 'M4 13h16']} size={12} stroke={1.7} />
      </button>
      {agent && (
        <button className="icon-btn" title="Open as a full-size popup" style={{ width: 22, height: 22, borderRadius: 6 }} onClick={() => setPopup(true)}>
          <Icon paths={['M14 4h6v6', 'M20 4L11 13', 'M10 5H5a1 1 0 00-1 1v13a1 1 0 001 1h13a1 1 0 001-1v-5']} size={12} stroke={1.7} />
        </button>
      )}
      <button className="icon-btn" title="Close" style={{ width: 22, height: 22, borderRadius: 6 }} onClick={() => { setChangesOpen(false); remember({ changes: false }) }}>
        <Icon paths={['M6 6l12 12', 'M18 6L6 18']} size={10} stroke={2} />
      </button>
    </PanelStrip>
  )

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{runTitle(run)}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent ? `${agent.repo} · ${agent.branch}` : task?.cwd ?? 'no working folder'}
            {agent?.machine ? <span style={{ color: 'var(--accent)' }}> · {agent.machine.label || 'remote'}</span> : null}
            {agent?.worktree ? <span style={{ color: 'var(--amber)' }}> · isolated</span> : null}
          </div>
        </div>
        {task && (
          <button
            className="icon-btn"
            title={showWatcher ? 'Hide the watcher chat' : 'Watcher chat — progress notes, questions & your replies'}
            style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0, color: showWatcher ? 'var(--accent)' : task.awaitingUser ? 'var(--amber)' : undefined }}
            onClick={() => { setWatcherOpen(v => { remember({ watcher: !v }); return !v }) }}
          >
            <Icon paths={['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12h5']} size={15} stroke={1.7} />
          </button>
        )}
        {cwd && (
          <button
            className="icon-btn"
            title={showChanges ? 'Hide the changes panel' : agent?.worktree ? 'Changes — diff, stage, commit & merge the worktree back' : 'Changes — live diff, stage & commit'}
            style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0, color: showChanges ? 'var(--accent)' : agent?.worktree ? 'var(--amber)' : undefined }}
            onClick={() => { setChangesOpen(v => { remember({ changes: !v }); return !v }) }}
          >
            <Icon paths={['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9']} size={15} stroke={1.7} />
          </button>
        )}
        {agent && (
          <button
            className="icon-btn"
            title="Open in the Work view (full pane: files, splits, session settings)"
            style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0 }}
            onClick={() => focusTab(agent.id)}
          >
            <Icon paths={['M14 4h6v6', 'M20 4L11 13', 'M10 5H5a1 1 0 00-1 1v13a1 1 0 001 1h13a1 1 0 001-1v-5']} size={13} stroke={1.8} />
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
        {/* center column: terminal/spec, with changes below when bottom-docked */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {agent ? <TerminalPane agent={agent} active /> : task ? <SpecBlock task={task} /> : <div style={{ flex: 1 }} />}
          {showChanges && changesDock === 'bottom' && (
            <div style={{ height: 'clamp(220px, 44%, 480px)', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
              {changesStrip}
              {workbench}
            </div>
          )}
        </div>
        {/* right column: changes on top, watcher chat in the bottom-right quarter */}
        {rightColOpen && (
          <div style={{
            width: 'clamp(360px, 42%, 720px)', flexShrink: 0, minHeight: 0, minWidth: 0,
            display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--line)', background: 'var(--panel)',
          }}>
            {changesRight && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {changesStrip}
                {workbench}
              </div>
            )}
            {showWatcher && task && (
              <div style={{
                ...(changesRight ? { height: '45%', borderTop: '1px solid var(--line)' } : { flex: 1 }),
                flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
              }}>
                <PanelStrip label="WATCHER">
                  <button className="icon-btn" title="Close" style={{ width: 22, height: 22, borderRadius: 6 }} onClick={() => { setWatcherOpen(false); remember({ watcher: false }) }}>
                    <Icon paths={['M6 6l12 12', 'M18 6L6 18']} size={10} stroke={2} />
                  </button>
                </PanelStrip>
                <WatcherChat task={task} />
              </div>
            )}
          </div>
        )}
      </div>
      {popup && agent && <GitPopup agent={agent} onClose={() => setPopup(false)} />}
    </div>
  )
}

const FILTERS: Array<{ id: RunFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'task', label: 'Tasks' },
  { id: 'session', label: 'Sessions' },
  { id: 'scheduled', label: 'Scheduled' },
]

/** The board's Mission Control mode: run list + selected-run cockpit. */
export function MissionControl() {
  const s = useConductorSelector(x => ({ tasks: x.tasks, agents: x.agents }), shallowEqual)
  const [filter, setFilter] = useState<RunFilter>('all')
  const groups = useMemo(() => groupRuns(s.tasks, s.agents, filter), [s.tasks, s.agents, filter])
  const flat = useMemo(() => groups.flatMap(g => g.runs), [groups])
  const [selKey, setSelKey] = useState<string | null>(null)
  const selected = flat.find(r => r.key === selKey) ?? flat[0]

  // live +/− stats for every run that has something to diff
  const statSources = useMemo(() => flat
    .map(r => r.agent)
    .filter((a): a is Agent => !!a && !a.archived)
    .map(a => ({ id: a.id, cwd: a.cwd, machine: a.machine, worktree: a.worktree })), [flat])
  const stats = useDiffStats(statSources)

  // ⌘1–9 jumps to the nth run in triage order
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 9) return
      const run = flat[n - 1]
      if (run) { e.preventDefault(); setSelKey(run.key) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flat])

  if (!flat.length && filter === 'all') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, background: 'var(--bg2)' }}>
        <div className="grotesk" style={{ fontSize: 15, fontWeight: 600, color: 'var(--mut)' }}>Nothing in flight</div>
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>Create a task or launch a session — every run lands here.</div>
      </div>
    )
  }

  let shortcutIx = 0
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 264, flexShrink: 0, borderRight: '1px solid var(--line)', overflowY: 'auto', background: 'var(--panel)', padding: '6px 6px 12px' }}>
        <div style={{ display: 'flex', gap: 2, margin: '4px 4px 8px', background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 9, padding: 2 }}>
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{
                flex: 1, minWidth: 0, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', borderRadius: 7, padding: 0, fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
                whiteSpace: 'nowrap', overflow: 'hidden',
                background: filter === f.id ? 'var(--panel2)' : 'transparent',
                color: filter === f.id ? 'var(--accent)' : 'var(--dim)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {!flat.length && (
          <div style={{ padding: '18px 10px', fontSize: 11.5, color: 'var(--dim)', textAlign: 'center' }}>
            No runs match this filter.
          </div>
        )}
        {groups.map(g => (
          <div key={g.id}>
            <div className="mono" style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 4px',
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6,
              color: g.id === 'needs' ? 'var(--amber)' : 'var(--dim)',
            }}>
              {g.label.toUpperCase()} <span style={{ color: 'var(--faint)' }}>{g.runs.length}</span>
            </div>
            {g.runs.map(run => {
              const ix = ++shortcutIx
              return (
                <RunRow
                  key={run.key}
                  run={run}
                  stats={run.agent ? stats[run.agent.id] : undefined}
                  selected={selected?.key === run.key}
                  shortcut={ix <= 9 ? ix : undefined}
                  onSelect={() => setSelKey(run.key)}
                />
              )
            })}
          </div>
        ))}
      </div>
      {selected && <RunDetail run={selected} />}
    </div>
  )
}
