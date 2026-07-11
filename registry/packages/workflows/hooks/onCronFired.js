// (input = { name, kind }, api) — a schedule fired. Workflow triggers are
// schedules named "wf-<workflow id>" armed from the Workflows tab. Workflows
// are STATE MACHINES: one active step at a time; each step declares where the
// machine goes on done / on fail (loops allowed, capped per run). Firing one
// starts a run at the workflow's start step.
if (!String(input.name || '').startsWith('wf-')) return

const wfId = String(input.name).slice(3)
const workflows = (await api.storage.get('workflows')) || []
const wf = workflows.find(w => w.id === wfId)
if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return

// one running machine per workflow — a slow pipeline must not stack on itself
const runs = (await api.storage.get('runs')) || []
if (runs.some(r => r.wfId === wf.id && r.status === 'running')) {
  await api.logEvent(`workflow "${wf.name}" skipped a cron trigger — previous run still going`)
  return
}

const start = wf.nodes.find(n => n.id === wf.start) || wf.nodes[0]
const run = {
  id: 'run' + Date.now().toString(36),
  wfId: wf.id, wfName: wf.name, startedAt: Date.now(), status: 'running',
  trigger: 'cron', current: start.id, taskId: null,
  visits: {}, path: [],
}

const taskId = await api.tasks.add(start.title, 'backlog', {
  description: [`[workflow "${wf.name}" · run ${run.id} · step ${start.id}]`, start.description || ''].filter(Boolean).join('\n\n'),
  criteria: start.criteria || [],
  cwd: start.cwd || undefined,
  isolate: start.isolate === true ? true : undefined,
})
run.taskId = taskId
run.visits[start.id] = 1
run.path.push({ nodeId: start.id, title: start.title, taskId, outcome: 'running', at: Date.now() })

// Checkpoint before launch: a fast one-shot may reach done immediately, and
// onTaskMoved must already be able to associate that task with this run.
await api.storage.set('runs', [run, ...runs].slice(0, 30))
await api.tasks.start(taskId)
await api.notify('Workflow started', `"${wf.name}" — entered step "${start.title}"`)
