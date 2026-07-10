// Pure state helpers for the board's Mission Control mode: fold tasks and
// loose workspace sessions into one triage-ordered list of "runs", grouped by
// what they need from the user — decisions first, live work second, everything
// else after. The board columns stay the planning view; this is the working
// view over the same records.
import type { Agent, BoardTask } from '../../core/types'

export type RunRef =
  | { kind: 'task'; key: string; task: BoardTask; agent?: Agent }
  | { kind: 'session'; key: string; agent: Agent }

export type RunGroupId = 'needs' | 'running' | 'idle' | 'done'

export interface RunGroup {
  id: RunGroupId
  label: string
  runs: RunRef[]
}

/** Which triage group a run belongs to. Precedence: anything waiting on the
 *  user (prompts, attention, review) → needs; a live agent → running; a
 *  finished/failed task → done; the rest (backlog, idle sessions) → idle. */
export function runGroupOf(run: RunRef): RunGroupId {
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  if (task?.awaitingUser || agent?.status === 'needs' || agent?.attention) return 'needs'
  if (task?.col === 'review') return 'needs'
  if (agent?.status === 'running') return 'running'
  if (task && (task.col === 'done' || task.col === 'failed')) return 'done'
  return 'idle'
}

/** Short status chip for a run row. */
export function runStatusLabel(run: RunRef): { label: string; tone: 'amber' | 'green' | 'mut' | 'red' } {
  const agent = run.agent
  const task = run.kind === 'task' ? run.task : undefined
  if (task?.awaitingUser || agent?.status === 'needs' || agent?.attention) return { label: 'waiting on you', tone: 'amber' }
  if (task?.col === 'review') return { label: 'review', tone: 'amber' }
  if (agent?.status === 'running') return { label: 'running', tone: 'green' }
  if (agent?.status === 'error' || task?.col === 'failed') return { label: 'failed', tone: 'red' }
  if (task?.col === 'done') return { label: 'done', tone: 'mut' }
  if (task && !agent) return { label: task.scheduleAt ? 'scheduled' : 'not started', tone: 'mut' }
  return { label: 'idle', tone: 'mut' }
}

/** Fold non-archived tasks + loose (non-task, non-chat) sessions into triage
 *  groups. Task runs come first inside each group, keeping board order. */
export function groupRuns(tasks: BoardTask[], agents: Agent[]): RunGroup[] {
  const liveTasks = tasks.filter(t => !t.archived)
  const byId = new Map(agents.map(a => [a.id, a]))
  // every agent any live task points at (current or historical one-shots)
  const taskAgentIds = new Set(liveTasks.flatMap(t => [t.agentId, ...(t.agentIds ?? [])]).filter(Boolean))

  const runs: RunRef[] = [
    ...liveTasks.map((t): RunRef => ({
      kind: 'task', key: `task:${t.id}`, task: t,
      agent: t.agentId ? byId.get(t.agentId) : undefined,
    })),
    ...agents
      .filter(a => !a.archived && a.kind !== 'chat' && !taskAgentIds.has(a.id))
      .map((a): RunRef => ({ kind: 'session', key: `sess:${a.id}`, agent: a })),
  ]

  const groups: RunGroup[] = [
    { id: 'needs', label: 'Needs you', runs: [] },
    { id: 'running', label: 'Running', runs: [] },
    { id: 'idle', label: 'Idle & queued', runs: [] },
    { id: 'done', label: 'Done', runs: [] },
  ]
  const byGroup = new Map(groups.map(g => [g.id, g]))
  for (const run of runs) byGroup.get(runGroupOf(run))!.runs.push(run)
  return groups.filter(g => g.runs.length > 0)
}
