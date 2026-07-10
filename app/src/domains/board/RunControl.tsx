import { useEffect, useMemo, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { indicatorColor } from '../../core/data'
import type { Agent, BoardTask } from '../../core/types'
import { Pane } from '../session/Pane'
import { useDiffStats } from '../session/diff-stats'
import { groupRuns, runStatusLabel } from './run-state'
import type { RunFilter, RunRef } from './run-state'
import { WatcherChat } from './WatcherChat'

// Runs: the Work view's triage mode (toggle at the top left of the tab bar).
// Every run (task sessions + loose sessions) in one urgency-grouped rail with
// live diff stats and working folders. Selecting a run opens the exact same
// session pane the tab layout uses — terminal, files, changes (with review &
// merge), settings, rename — so nothing needs relearning. ⌘1–9 jumps runs.

const TONE: Record<string, string> = {
  amber: 'var(--amber)', green: 'var(--green)', red: 'var(--red-soft)', mut: 'var(--dim)',
}

function runTitle(run: RunRef): string {
  return run.kind === 'task' ? run.task.title : run.agent.name
}

/** The folder a run works in (worktree beats session cwd beats task cwd). */
function runCwd(run: RunRef): string | undefined {
  const task = run.kind === 'task' ? run.task : undefined
  return run.agent?.worktree?.workdir ?? run.agent?.cwd ?? task?.cwd
}

/** One selectable run row: status dot, title, working folder, live diff stats,
 *  and an inline start for unstarted tasks (backlog). */
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
  const cwd = runCwd(run)
  const folder = cwd?.replace(/\/+$/, '').split('/').pop()
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
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', fontSize: 10, paddingLeft: 15, minWidth: 0 }}>
        <span style={{ color: TONE[st.tone], flexShrink: 0 }}>{st.label}</span>
        {folder && (
          <span title={cwd} style={{ color: 'var(--mut)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            ▸ {folder}
          </span>
        )}
        {agent?.machine && <span style={{ color: 'var(--accent)', flexShrink: 0 }}>⧉ {agent.machine.label || 'remote'}</span>}
        {agent?.worktree && <span style={{ color: 'var(--amber)', flexShrink: 0 }}>⑂</span>}
        {stats && stats.files > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--dim)', flexShrink: 0 }}>
            <span style={{ color: 'var(--green)' }}>+{stats.add}</span> <span style={{ color: 'var(--red-soft)' }}>−{stats.del}</span> · {stats.files}
          </span>
        )}
      </div>
    </button>
  )
}

/** Detail for a task run without a live session: spec + start, with the
 *  watcher chat beside it once a conversation exists. */
function TaskPreview({ task }: { task: BoardTask }) {
  const { startTask } = useActions()
  const hasChat = task.awaitingUser || (task.chat ?? []).some(m => m.role !== 'system')
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg2)' }}>
      <div style={{ height: 42, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 12px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.title}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.col.toUpperCase()}{task.cwd ? ` · ${task.cwd}` : ' · no working folder'}
          </div>
        </div>
        {task.col !== 'done' && task.col !== 'failed' && (
          <button className="approve-btn" style={{ flex: 'none', padding: '5px 16px', fontSize: 12 }} onClick={() => startTask(task.id)}>
            ▶ Start session
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '18px 22px' }}>
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
        </div>
        {hasChat && (
          <div style={{ width: 'clamp(320px, 40%, 560px)', flexShrink: 0, minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--line)', background: 'var(--panel)' }}>
            <WatcherChat task={task} />
          </div>
        )}
      </div>
    </div>
  )
}

const FILTERS: Array<{ id: RunFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'task', label: 'Tasks' },
  { id: 'session', label: 'Sessions' },
  { id: 'scheduled', label: 'Scheduled' },
]

/** The Work view's Runs mode: triage rail + the standard session pane. */
export function RunControl() {
  const s = useConductorSelector(x => ({ tasks: x.tasks, agents: x.agents, activeWorkspace: x.activeWorkspace }), shallowEqual)
  const [filter, setFilter] = useState<RunFilter>('all')
  const groups = useMemo(
    () => groupRuns(s.tasks, s.agents, filter, s.activeWorkspace),
    [s.tasks, s.agents, filter, s.activeWorkspace],
  )
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
      {selected && (
        selected.agent
          ? <Pane key={selected.agent.id} agent={selected.agent} index={0} active showRing={false} maximized={false} standalone />
          : selected.kind === 'task'
            ? <TaskPreview key={selected.task.id} task={selected.task} />
            : <div style={{ flex: 1, background: 'var(--bg2)' }} />
      )}
    </div>
  )
}
