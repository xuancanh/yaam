import { useEffect, useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { indicatorColor } from '../../core/data'
import type { Agent, BoardTask } from '../../core/types'
import { Pane } from '../session/Pane'
import { SessionHoverPreview } from '../session/SessionHoverPreview'
import { sessionWorkStatus } from '../session/session-work-status'
import { useDiffStats } from '../session/diff-stats'
import { pendingEscalation } from '../session/escalations'
import type { Escalation } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { brainOn } from '../../llm/client'
import { groupRuns, groupRunsByFolder, runCwdOf, runNeedsUserAction, runStatusLabel } from './run-state'
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

const SEG_WRAP = {
  display: 'flex', gap: 2, background: 'var(--bg2)', border: '1px solid var(--line)',
  borderRadius: 9, padding: 2,
} as const

const segBtn = (active: boolean) => ({
  flex: 1, minWidth: 0, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
  gap: 5, border: 'none', borderRadius: 7, padding: '0 4px', fontSize: 11, fontWeight: 600,
  cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
  background: active ? 'var(--panel2)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--dim)',
} as const)

/** Sticky group header shell: keeps its label readable while rows scroll under. */
const HEADER_STYLE = {
  position: 'sticky', top: 0, zIndex: 2, background: 'var(--panel)',
  display: 'flex', alignItems: 'center', gap: 6, padding: '9px 6px 5px', minWidth: 0,
} as const

function FolderGlyph({ color, size = 12 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  )
}

function runTitle(run: RunRef): string {
  return run.kind === 'task' ? run.task.title : run.agent.name
}

/** One selectable run row: status dot, title, working folder, live diff stats,
 *  and an inline start for unstarted tasks (backlog). */
function RunRow({ run, linkedTask, stats, selected, shortcut, showDetails, briefsOn, showFolder = true, approval, onSelect }: {
  run: RunRef
  linkedTask?: BoardTask
  stats?: { add: number; del: number; files: number }
  selected: boolean
  shortcut?: number
  showDetails: boolean
  /** Master Brain on: TASK/NOW/NEXT briefs exist and are worth the rows */
  briefsOn: boolean
  /** off when the rail already groups rows under a folder header */
  showFolder?: boolean
  /** the session's pending escalation, answerable inline */
  approval?: Escalation
  onSelect: () => void
}) {
  const { startTask, answerPrompt, approve, deny } = useActions()
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : linkedTask
  const st = runStatusLabel(run)
  const work = sessionWorkStatus(agent, task)
  const flash = st.tone === 'amber'
  // without the brain the briefs are permanent placeholders — never expand
  const expanded = briefsOn && (showDetails || runNeedsUserAction(run))
  const startable = !!task && !agent && task.col !== 'done' && task.col !== 'failed'
  const cwd = runCwdOf(run)
  const folder = showFolder ? cwd?.replace(/\/+$/, '').split('/').pop() : undefined
  const row = (
    <button
      className="palette-item"
      onClick={onSelect}
      aria-expanded={expanded}
      style={{
        width: '100%', display: 'flex', flexDirection: 'column', gap: expanded ? 3 : 2.5,
        padding: expanded ? '8px 10px 9px' : '7px 10px', textAlign: 'left',
        background: selected ? 'var(--accent-soft)' : 'transparent', border: 'none',
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
          <span title={cwd} style={{ color: 'var(--dim)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {folder}
          </span>
        )}
        {agent?.machine && <span style={{ color: 'var(--accent)', flexShrink: 0 }}>⧉ {agent.machine.label || 'remote'}</span>}
        {agent?.worktree && <span style={{ color: 'var(--amber)', flexShrink: 0 }}>⑂</span>}
        {agent?.runUsage && agent.status !== 'running' && (
          <span title={`token usage · ${agent.runUsage.inputTokens} in / ${agent.runUsage.outputTokens} out`} style={{ color: 'var(--faint)', flexShrink: 0 }}>
            {Math.round((agent.runUsage.inputTokens + agent.runUsage.outputTokens) / 1000)}k tok
          </span>
        )}
        {stats && stats.files > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--dim)', flexShrink: 0 }}>
            <span style={{ color: 'var(--green)' }}>+{stats.add}</span> <span style={{ color: 'var(--red-soft)' }}>−{stats.del}</span> · {stats.files}
          </span>
        )}
      </div>
      {agent?.status === 'needs' && (() => {
        const reason = approval?.reason || agent.escReason || agent.actionNeeded
        const options = approval?.options ?? []
        const chip = {
          display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 6,
          border: '1px solid var(--line2)', fontSize: 10.5, fontWeight: 600, cursor: 'pointer',
          color: 'var(--text2)', whiteSpace: 'nowrap' as const, maxWidth: 150,
          overflow: 'hidden' as const, textOverflow: 'ellipsis' as const,
        }
        const act = (e: MouseEvent, fn: () => void) => { e.stopPropagation(); fn() }
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', paddingLeft: 15, paddingTop: 2 }}>
            {reason && (
              <span style={{ fontSize: 10.5, color: 'var(--amber)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {reason}
              </span>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {options.length > 0
                ? options.slice(0, 4).map(o => (
                    <span key={o.num} role="button" title={o.label} style={chip} onClick={e => act(e, () => answerPrompt(agent.id, o.num))}>
                      {o.num} · {o.label}
                    </span>
                  ))
                : (
                  <>
                    <span role="button" style={{ ...chip, color: 'var(--green)', borderColor: 'var(--green)' }} onClick={e => act(e, () => approve(agent.id))}>
                      Approve
                    </span>
                    <span role="button" style={{ ...chip, color: 'var(--red-soft)', borderColor: 'var(--red-soft)' }} onClick={e => act(e, () => deny(agent.id))}>
                      Deny
                    </span>
                  </>
                )}
            </div>
          </div>
        )
      })()}
      {expanded && ([
        ['TASK', work.task, 'var(--accent)'],
        ['NOW', work.current, 'var(--mut2)'],
        ['NEXT', work.next, agent?.actionNeeded || task?.awaitingUser ? 'var(--amber)' : 'var(--green)'],
      ] as const).map(([label, value, color]) => (
        <div key={label} title={value} style={{ display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr)', gap: 5, width: '100%', paddingLeft: 15, fontSize: 10, lineHeight: 1.35 }}>
          <span className="mono" style={{ color: 'var(--faint)', fontSize: 8.5, letterSpacing: .45 }}>{label}</span>
          <span style={{ color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
        </div>
      ))}
    </button>
  )
  return agent ? <SessionHoverPreview agent={agent} task={task} placement="right">{row}</SessionHoverPreview> : row
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
  const s = useConductorSelector(x => ({
    tasks: x.tasks, agents: x.agents, activeWorkspace: x.activeWorkspace, messages: x.messages,
    runListMode: x.settings.runListMode ?? 'compact',
    runGroupMode: x.settings.runGroupMode ?? 'status',
    briefsOn: brainOn(x.settings),
  }), shallowEqual)
  const { updateSettings, unarchiveSession, openNewSession } = useActions()
  const [filter, setFilter] = useState<RunFilter>('all')
  const byFolder = s.runGroupMode === 'folder'
  const groups = useMemo(
    () => groupRuns(s.tasks, s.agents, filter, s.activeWorkspace),
    [s.tasks, s.agents, filter, s.activeWorkspace],
  )
  const folderGroups = useMemo(
    () => groupRunsByFolder(s.tasks, s.agents, filter, s.activeWorkspace),
    [s.tasks, s.agents, filter, s.activeWorkspace],
  )
  const flat = useMemo(() => groups.flatMap(g => g.runs), [groups])
  // folders whose archived-session list is open
  const [openArchives, setOpenArchives] = useState<Set<string>>(new Set())
  const taskByAgent = useMemo(() => {
    const map = new Map<string, BoardTask>()
    for (const task of s.tasks) {
      if (task.archived) continue
      if (task.agentId) map.set(task.agentId, task)
      for (const id of task.agentIds ?? []) if (!map.has(id)) map.set(id, task)
    }
    return map
  }, [s.tasks])
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

  // in folder mode an all-archived workspace still has history worth showing
  const hasArchived = folderGroups.some(g => g.archived.length > 0)
  if (!flat.length && filter === 'all' && !(byFolder && hasArchived)) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, background: 'var(--bg2)' }}>
        <div className="grotesk" style={{ fontSize: 15, fontWeight: 600, color: 'var(--mut)' }}>Nothing in flight</div>
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>Create a task or launch a session — every run lands here.</div>
      </div>
    )
  }

  // ⌘n follows triage order in both groupings, so the numbers never move
  // when the user switches between Status and Folder
  const shortcutByKey = new Map(flat.slice(0, 9).map((r, i) => [r.key, i + 1]))
  // restoring puts the session back among live runs; select its new row
  // (the task run when a live task owns this agent, else the loose session)
  const restoreArchived = (a: Agent) => {
    unarchiveSession(a.id)
    const owner = s.tasks.find(t => !t.archived && t.agentId === a.id)
    setSelKey(owner ? `task:${owner.id}` : `sess:${a.id}`)
  }
  const renderRun = (run: RunRef, showFolder: boolean) => (
    <RunRow
      key={run.key}
      run={run}
      linkedTask={run.agent ? taskByAgent.get(run.agent.id) : undefined}
      stats={run.agent ? stats[run.agent.id] : undefined}
      selected={selected?.key === run.key}
      shortcut={shortcutByKey.get(run.key)}
      showDetails={s.runListMode === 'full'}
      briefsOn={s.briefsOn}
      showFolder={showFolder}
      approval={run.agent?.status === 'needs' ? pendingEscalation(s.messages, run.agent.id) : undefined}
      onSelect={() => setSelKey(run.key)}
    />
  )
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{
        width: 'clamp(248px, 26vw, 312px)', flexShrink: 0, borderRight: '1px solid var(--line)',
        background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0,
      }}>
        <div style={{ flexShrink: 0, padding: '8px 8px 7px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={SEG_WRAP}>
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={segBtn(filter === f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <div style={{ ...SEG_WRAP, flex: 1 }}>
              <button
                title="Group by what each run needs from you — urgent first"
                onClick={() => updateSettings({ runGroupMode: 'status' })}
                style={segBtn(!byFolder)}
              >
                <Icon paths={['M4 6h16', 'M4 12h11', 'M4 18h7']} size={11} stroke={1.8} />
                Status
              </button>
              <button
                title="Group by working folder — archived sessions stay one click away"
                onClick={() => updateSettings({ runGroupMode: 'folder' })}
                style={segBtn(byFolder)}
              >
                <FolderGlyph color="currentColor" size={11} />
                Folder
              </button>
            </div>
            {s.briefsOn && (
              <button
                className="icon-btn"
                title={s.runListMode === 'full'
                  ? 'Hide the Task / Now / Next briefs (rows expand only when action is needed)'
                  : 'Show Task / Now / Next briefs on every row'}
                aria-pressed={s.runListMode === 'full'}
                onClick={() => updateSettings({ runListMode: s.runListMode === 'full' ? 'compact' : 'full' })}
                style={{
                  width: 30, flexShrink: 0, borderRadius: 8,
                  background: s.runListMode === 'full' ? 'var(--accent-soft)' : 'transparent',
                  color: s.runListMode === 'full' ? 'var(--accent)' : 'var(--dim)',
                }}
              >
                <Icon paths={['M5 7h14', 'M5 12h14', 'M5 17h8']} size={13} stroke={1.8} />
              </button>
            )}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 12px' }}>
          {!flat.length && !(byFolder && hasArchived) && (
            <div style={{ padding: '18px 10px', fontSize: 11.5, color: 'var(--dim)', textAlign: 'center' }}>
              No runs match this filter.
            </div>
          )}
          {!byFolder && groups.map(g => (
            <div key={g.id}>
              <div style={HEADER_STYLE}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                  background: g.id === 'needs' ? 'var(--amber)' : g.id === 'running' ? 'var(--green)' : 'var(--faint)',
                }} />
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
                  color: g.id === 'needs' ? 'var(--amber)' : 'var(--mut)', flexShrink: 0,
                }}>
                  {g.label}
                </span>
                <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
                <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{g.runs.length}</span>
              </div>
              {g.runs.map(run => renderRun(run, true))}
            </div>
          ))}
          {byFolder && folderGroups.map(g => {
            const open = openArchives.has(g.cwd)
            const needs = g.runs.some(runNeedsUserAction)
            return (
              <div key={g.cwd || '(none)'}>
                <div title={g.cwd || undefined} style={HEADER_STYLE}>
                  <FolderGlyph color={needs ? 'var(--amber)' : 'var(--dim)'} />
                  <span style={{
                    fontSize: 11.5, fontWeight: 650, minWidth: 0,
                    color: needs ? 'var(--text)' : 'var(--mut2)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {g.label}
                  </span>
                  {g.runs.length > 0 && (
                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{g.runs.length}</span>
                  )}
                  <span style={{ flex: 1, height: 1, background: 'var(--line-soft)' }} />
                  <button
                    className="icon-btn"
                    title={g.cwd ? `New session in ${g.cwd}` : 'New session'}
                    onClick={() => openNewSession(g.cwd || undefined)}
                    style={{ width: 20, height: 20, borderRadius: 6, border: 'none', flexShrink: 0 }}
                  >
                    <Icon paths={IC.plus} size={11} stroke={2} />
                  </button>
                </div>
                {g.runs.map(run => renderRun(run, false))}
                {g.runs.length === 0 && g.archived.length > 0 && !open && (
                  <div style={{ padding: '2px 10px 4px', fontSize: 11, color: 'var(--faint)' }}>
                    Nothing running here.
                  </div>
                )}
                {g.archived.length > 0 && (
                  <>
                    <button
                      className="palette-item"
                      aria-expanded={open}
                      onClick={() => setOpenArchives(prev => {
                        const next = new Set(prev)
                        if (open) next.delete(g.cwd); else next.add(g.cwd)
                        return next
                      })}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                        background: 'transparent', border: 'none', borderRadius: 7, cursor: 'pointer', color: 'var(--dim)',
                      }}
                    >
                      <span aria-hidden style={{
                        display: 'flex', fontSize: 7, color: 'var(--faint)', width: 8, justifyContent: 'center',
                        transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s',
                      }}>▶</span>
                      <span style={{ fontSize: 11, fontWeight: 600 }}>Archived · {g.archived.length}</span>
                    </button>
                    {open && g.archived.map(a => (
                      <button
                        key={a.id}
                        className="palette-item"
                        title={`Restore ${a.name} from the archive`}
                        onClick={() => restoreArchived(a)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px 5px 24px',
                          background: 'transparent', border: 'none', borderRadius: 7, cursor: 'pointer', textAlign: 'left',
                        }}
                      >
                        <span style={{ width: 7, height: 7, borderRadius: '50%', border: '1px solid var(--dim)', flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {a.name}
                        </span>
                        <span className="mono reveal-on-hover" style={{ fontSize: 9, color: 'var(--accent)', flexShrink: 0 }}>RESTORE</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )
          })}
        </div>
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
