import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onTaskMoved'> = async (input, api) => {
// (input = { taskId, title, col, from }, api) — a board task changed column.
// Workflows are STATE MACHINES: if this task is the active step of a running
// machine, take the step's transition — onDone when the task reached done,
// onFail when it failed. No transition = the machine halts there (done/failed).
// Loops are legal; each step may run at most `maxVisits` (default 3) per run.
if (input.col !== 'done' && input.col !== 'failed') return

const runs = (await api.storage.get('runs')) || []
const run = runs.find(r => r.status === 'running' && r.taskId === input.taskId)
if (!run) return

const workflows = (await api.storage.get('workflows')) || []
const wf = workflows.find(w => w.id === run.wfId)
const node = wf && wf.nodes.find(n => n.id === run.current)

const outcome = input.col === 'done' ? 'done' : 'failed'
const last = run.path[run.path.length - 1]
if (last && last.taskId === input.taskId) last.outcome = outcome

const nextId = node ? (outcome === 'done' ? node.onDone : node.onFail) : null
const next = nextId && wf ? wf.nodes.find(n => n.id === nextId) : null

const halt = async (status, why) => {
  run.status = status
  run.current = null
  run.taskId = null
  run.finishedAt = Date.now()
  await api.storage.set('runs', runs)
  await api.notify(status === 'done' ? 'Workflow finished' : 'Workflow failed',
    `"${run.wfName}" — ${why}`)
}

if (!next) {
  // terminal state: done with no onDone = success; failed with no onFail = failure
  await halt(outcome, outcome === 'done'
    ? `halted after "${input.title}" (terminal step)`
    : `step "${input.title}" failed with no failure transition`)
  return
}

const visits = (run.visits[next.id] || 0) + 1
const cap = Number(next.maxVisits) > 0 ? Number(next.maxVisits) : 3
if (visits > cap) {
  await halt('failed', `step "${next.title}" exceeded its ${cap}-visit cap — breaking the loop`)
  return
}

// take the transition: launch the next step's task and move the machine there
const taskId = await api.tasks.add(next.title, 'backlog', {
  description: [
    `[workflow "${wf.name}" · run ${run.id} · step ${next.id} · visit ${visits}]`,
    outcome === 'failed' ? `You are the failure branch: the previous step "${node.title}" FAILED — diagnose and remedy before/while doing your own work.` : '',
    next.description || '',
  ].filter(Boolean).join('\n\n'),
  criteria: next.criteria || [],
  cwd: next.cwd || undefined,
  isolate: next.isolate === true ? true : undefined,
})
run.current = next.id
run.taskId = taskId
run.visits[next.id] = visits
run.path.push({ nodeId: next.id, title: next.title, taskId, outcome: 'running', at: Date.now(), via: outcome })
// Checkpoint the transition before launch so an immediately-completing
// one-shot cannot emit onTaskMoved while the run still points at the old task.
await api.storage.set('runs', runs)
await api.tasks.start(taskId)
await api.logEvent(`workflow "${run.wfName}": ${outcome === 'done' ? '✓' : '✗'} "${input.title}" → "${next.title}"${visits > 1 ? ' (visit ' + visits + ')' : ''}`)
}

export default handler
