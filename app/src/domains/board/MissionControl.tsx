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
import type { RunRef } from './mission-state'
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

/** One selectable run row: status dot, title, chip, live diff stats. */
function RunRow({ run, stats, selected, shortcut, onSelect }: {
  run: RunRef
  stats?: { add: number; del: number; files: number }
  selected: boolean
  shortcut?: number
  onSelect: () => void
}) {
  const agent = run.agent
  const st = runStatusLabel(run)
  const flash = st.tone === 'amber'
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

type Tab = 'agent' | 'watcher' | 'changes'
/** how the Changes tab lays out: alone, or docked beside/below the terminal */
type ChangesView = 'full' | 'right' | 'bottom'
const changesViewCache = new Map<string, ChangesView>()

/** Right side: the selected run's terminal / watcher chat / changes. */
function RunDetail({ run }: { run: RunRef }) {
  const { focusTab } = useActions()
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  const inReview = task?.col === 'review'
  // land on what the run most likely needs: review → changes, else the agent
  const [tab, setTab] = useState<Tab>(inReview ? 'changes' : 'agent')
  useEffect(() => { setTab(inReview ? 'changes' : 'agent') }, [run.key, inReview])
  const [changesView, setChangesView] = useState<ChangesView>(changesViewCache.get(run.key) ?? 'full')
  const [popup, setPopup] = useState(false)
  useEffect(() => { setChangesView(changesViewCache.get(run.key) ?? 'full'); setPopup(false) }, [run.key])
  const setView = (v: ChangesView) => { changesViewCache.set(run.key, v); setChangesView(v) }

  const cwd = agent?.worktree?.workdir ?? agent?.cwd ?? task?.cwd
  const fs = useMemo(() => sessionFs(agent?.machine, agent?.id ?? ''), [agent?.machine, agent?.id])

  const tabs: { id: Tab; label: string; on: boolean }[] = [
    { id: 'agent', label: agent ? 'Agent' : 'Spec', on: true },
    { id: 'watcher', label: 'Watcher', on: !!task },
    { id: 'changes', label: 'Changes', on: !!cwd },
  ]

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{runTitle(run)}</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent ? `${agent.repo} · ${agent.branch}` : task?.cwd ?? 'no working folder'}
            {agent?.machine ? <span style={{ color: 'var(--accent)' }}> · {agent.machine.label || 'remote'}</span> : null}
            {agent?.worktree ? <span style={{ color: 'var(--amber)' }}> · isolated</span> : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 9, padding: 2, flexShrink: 0 }}>
          {tabs.filter(t => t.on).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                background: tab === t.id ? 'var(--panel2)' : 'transparent',
                color: tab === t.id ? 'var(--accent)' : 'var(--mut)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'changes' && cwd && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <button
              className="icon-btn"
              title="Changes only (full width)"
              style={{ width: 24, height: 24, borderRadius: 6, color: changesView === 'full' ? 'var(--accent)' : undefined }}
              onClick={() => setView('full')}
            >
              <Icon paths={['M4 5h16v14H4z']} size={12} stroke={1.7} />
            </button>
            {agent && (
              <>
                <button
                  className="icon-btn"
                  title="Changes beside the terminal"
                  style={{ width: 24, height: 24, borderRadius: 6, color: changesView === 'right' ? 'var(--accent)' : undefined }}
                  onClick={() => setView('right')}
                >
                  <Icon paths={['M4 5h16v14H4z', 'M14 5v14']} size={12} stroke={1.7} />
                </button>
                <button
                  className="icon-btn"
                  title="Changes below the terminal"
                  style={{ width: 24, height: 24, borderRadius: 6, color: changesView === 'bottom' ? 'var(--accent)' : undefined }}
                  onClick={() => setView('bottom')}
                >
                  <Icon paths={['M4 5h16v14H4z', 'M4 13h16']} size={12} stroke={1.7} />
                </button>
                <button
                  className="icon-btn"
                  title="Open the changes as a full-size popup"
                  style={{ width: 24, height: 24, borderRadius: 6 }}
                  onClick={() => setPopup(true)}
                >
                  <Icon paths={['M14 4h6v6', 'M20 4L11 13', 'M10 5H5a1 1 0 00-1 1v13a1 1 0 001 1h13a1 1 0 001-1v-5']} size={12} stroke={1.7} />
                </button>
              </>
            )}
          </div>
        )}
        {agent && (
          <button
            className="icon-btn"
            title="Open in the Work view (full pane: files, splits, session settings)"
            style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0 }}
            onClick={() => focusTab(agent.id)}
          >
            <Icon paths={['M14 4h6v6', 'M20 4L11 13', 'M10 5H5a1 1 0 00-1 1v13a1 1 0 001 1h13a1 1 0 001-1v-5']} size={13} stroke={1.8} />
          </button>
        )}
      </div>

      {tab === 'agent' && (
        agent
          ? <TerminalPane agent={agent} active />
          : task
            ? <SpecBlock task={task} />
            : null
      )}
      {tab === 'watcher' && task && <WatcherChat task={task} />}
      {tab === 'changes' && cwd && (() => {
        const workbench = (
          <GitWorkbench
            key={run.key}
            cwd={agent?.cwd ?? task?.cwd}
            worktree={agent?.worktree}
            fs={fs}
            compact={changesView === 'right'}
            footer={
              task && inReview
                ? <TaskReviewFooter task={task} onClose={() => {}} />
                : agent?.worktree
                  ? <WorktreeMergeBar agent={agent} />
                  : undefined
            }
          />
        )
        // full: changes alone · right/bottom: terminal + docked changes
        if (changesView === 'full' || !agent) return workbench
        return (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: changesView === 'bottom' ? 'column' : 'row' }}>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <TerminalPane agent={agent} active />
            </div>
            <div style={{
              ...(changesView === 'bottom'
                ? { height: 'clamp(220px, 44%, 480px)', borderTop: '1px solid var(--line)' }
                : { width: 'clamp(380px, 46%, 760px)', borderLeft: '1px solid var(--line)' }),
              flexShrink: 0, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--panel)',
            }}>
              {workbench}
            </div>
          </div>
        )
      })()}
      {popup && agent && <GitPopup agent={agent} onClose={() => setPopup(false)} />}
    </div>
  )
}

/** The board's Mission Control mode: run list + selected-run cockpit. */
export function MissionControl() {
  const s = useConductorSelector(x => ({ tasks: x.tasks, agents: x.agents }), shallowEqual)
  const groups = useMemo(() => groupRuns(s.tasks, s.agents), [s.tasks, s.agents])
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

  if (!flat.length) {
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
