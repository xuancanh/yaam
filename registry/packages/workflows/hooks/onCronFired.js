// (input = { name, kind }, api) — a schedule fired. Workflow triggers are
// schedules named "wf-<workflow id>" created from the Workflows tab; when one
// fires, start a run of that workflow: spawn every root node (no deps) as a
// board task and record the run in history.
if (!String(input.name || '').startsWith('wf-')) return

const wfId = String(input.name).slice(3)
const workflows = (await api.storage.get('workflows')) || []
const wf = workflows.find(w => w.id === wfId)
if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return

// one running run per workflow — a slow pipeline must not stack on itself
const runs = (await api.storage.get('runs')) || []
if (runs.some(r => r.wfId === wf.id && r.status === 'running')) {
  await api.logEvent(`workflow "${wf.name}" skipped a cron trigger — previous run still going`)
  return
}

const run = {
  id: 'run' + Date.now().toString(36),
  wfId: wf.id, wfName: wf.name, startedAt: Date.now(), status: 'running',
  trigger: 'cron', nodes: {},
}
for (const n of wf.nodes) run.nodes[n.id] = { taskId: null, status: 'pending' }

// start every root (a node whose deps are all… nonexistent)
for (const n of wf.nodes) {
  if ((n.deps || []).length) continue
  const taskId = await api.tasks.add(n.title, 'backlog', {
    description: [`[workflow "${wf.name}" · run ${run.id} · node ${n.id}]`, n.description || ''].filter(Boolean).join('\n\n'),
    criteria: n.criteria || [],
    cwd: n.cwd || undefined,
    isolate: n.isolate === true ? true : undefined,
  })
  await api.tasks.start(taskId)
  run.nodes[n.id] = { taskId, status: 'running' }
}

await api.storage.set('runs', [run, ...runs].slice(0, 30))
await api.notify('Workflow started', `"${wf.name}" — ${Object.values(run.nodes).filter(x => x.status === 'running').length} root task(s) launched`)
