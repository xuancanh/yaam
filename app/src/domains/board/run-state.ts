// Pure state helpers for the Control Center's Runs view: fold tasks and
// loose workspace sessions into one triage-ordered list of "runs", grouped by
// what they need from the user — decisions first, live work second, everything
// else after. The board columns stay the planning view; this is the working
// view over the same records.
import type { Agent, BoardTask } from '../../core/types'

export type RunRef =
  | { kind: 'task'; key: string; task: BoardTask; agent?: Agent }
  | { kind: 'session'; key: string; agent: Agent }

export type RunGroupId = 'needs' | 'running' | 'backlog' | 'idle' | 'done'

export interface RunGroup {
  id: RunGroupId
  label: string
  runs: RunRef[]
}

/** True when a compact Sidebar row must open to expose what the user needs to
 * do. This drives both triage ordering and row density so actionable work can
 * never remain hidden in a collapsed row. */
export function runNeedsUserAction(run: RunRef): boolean {
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  return Boolean(
    task?.awaitingUser
    || task?.col === 'review'
    || task?.col === 'failed'
    || agent?.status === 'needs'
    || agent?.status === 'error'
    || agent?.attention
    || agent?.actionNeeded,
  )
}

/** Which triage group a run belongs to. Precedence: anything waiting on the
 *  user (prompts, attention, review) → needs; a live agent → running;
 *  unstarted backlog tasks → backlog (startable in place); a finished task →
 *  done; the rest (paused progress, idle sessions) → idle. */
export function runGroupOf(run: RunRef): RunGroupId {
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  if (runNeedsUserAction(run)) return 'needs'
  if (agent?.status === 'running') return 'running'
  if (task?.col === 'done') return 'done'
  if (task && task.col === 'backlog' && !agent) return 'backlog'
  return 'idle'
}

export type RunFilter = 'all' | 'task' | 'session' | 'scheduled'

/** Filter predicate for the run list. 'scheduled' = tasks with a pending
 *  start time or created by a schedule (their opening chat note records it). */
export function runMatchesFilter(run: RunRef, filter: RunFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'task') return run.kind === 'task'
  if (filter === 'session') return run.kind === 'session'
  const task = run.kind === 'task' ? run.task : undefined
  if (!task) return false
  return !!task.scheduleAt || !!(task.chat ?? []).some(m => m.role === 'system' && m.text.startsWith('Added by schedule'))
}

/** Short status chip for a run row. */
export function runStatusLabel(run: RunRef): { label: string; tone: 'amber' | 'green' | 'mut' | 'red' } {
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  if (agent?.status === 'error' || task?.col === 'failed') return { label: 'failed', tone: 'red' }
  if (task?.col === 'review') return { label: 'review', tone: 'amber' }
  if (agent?.actionNeeded) return { label: 'action needed', tone: 'amber' }
  if (task?.awaitingUser || agent?.status === 'needs' || agent?.attention) return { label: 'waiting on you', tone: 'amber' }
  if (agent?.status === 'running') return { label: 'running', tone: 'green' }
  if (task?.col === 'done') return { label: 'done', tone: 'mut' }
  if (task && !agent) return { label: task.scheduleAt ? 'scheduled' : 'not started', tone: 'mut' }
  return { label: 'idle', tone: 'mut' }
}

/** Fold non-archived tasks + loose (non-task, non-chat) sessions into triage
 *  groups. Task runs come first inside each group, keeping board order. When a
 *  workspace is supplied, global sessions are narrowed to that workspace. */
export function groupRuns(tasks: BoardTask[], agents: Agent[], filter: RunFilter = 'all', workspaceId?: string): RunGroup[] {
  const liveTasks = tasks.filter(t => !t.archived)
  const scopedAgents = workspaceId
    ? agents.filter(a => (a.workspaceId ?? workspaceId) === workspaceId)
    : agents
  const byId = new Map(scopedAgents.map(a => [a.id, a]))
  // The current task session is represented by its task run. Additional
  // parallel/historical sessions remain standalone runs so they do not vanish.
  const representedTaskAgentIds = new Set(liveTasks.map(t => t.agentId).filter(Boolean))

  const runs: RunRef[] = [
    ...liveTasks.map((t): RunRef => ({
      kind: 'task', key: `task:${t.id}`, task: t,
      agent: t.agentId ? byId.get(t.agentId) : undefined,
    })),
    ...scopedAgents
      .filter(a => !a.archived && a.kind !== 'chat' && !representedTaskAgentIds.has(a.id))
      .map((a): RunRef => ({ kind: 'session', key: `sess:${a.id}`, agent: a })),
  ]

  const groups: RunGroup[] = [
    { id: 'needs', label: 'Needs you', runs: [] },
    { id: 'running', label: 'Running', runs: [] },
    { id: 'backlog', label: 'Backlog', runs: [] },
    { id: 'idle', label: 'Idle', runs: [] },
    { id: 'done', label: 'Done', runs: [] },
  ]
  const byGroup = new Map(groups.map(g => [g.id, g]))
  for (const run of runs) {
    if (runMatchesFilter(run, filter)) byGroup.get(runGroupOf(run))!.runs.push(run)
  }
  return groups.filter(g => g.runs.length > 0)
}
