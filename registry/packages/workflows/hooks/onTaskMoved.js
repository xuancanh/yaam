// (input = { taskId, title, col, from }, api) — a board task changed column.
// If it belongs to a running workflow run, advance the DAG: a node whose task
// reached done unlocks every dependent whose deps are now all done; a failed
// task fails the whole run (dependents would build on broken output).
if (input.col !== 'done' && input.col !== 'failed') return

const runs = (await api.storage.get('runs')) || []
const run = runs.find(r => r.status === 'running' && Object.values(r.nodes).some(n => n.taskId === input.taskId))
if (!run) return

const workflows = (await api.storage.get('workflows')) || []
const wf = workflows.find(w => w.id === run.wfId)

const nodeId = Object.keys(run.nodes).find(id => run.nodes[id].taskId === input.taskId)
run.nodes[nodeId].status = input.col === 'done' ? 'done' : 'failed'

if (input.col === 'failed') {
  run.status = 'failed'
  run.finishedAt = Date.now()
  await api.storage.set('runs', runs)
  await api.notify('Workflow failed', `"${run.wfName}" — node "${input.title}" failed; downstream nodes not started`)
  return
}

// start every dependent whose dependencies are now all done
if (wf) {
  for (const n of wf.nodes) {
    const cell = run.nodes[n.id]
    if (!cell || cell.status !== 'pending') continue
    const deps = n.deps || []
    if (!deps.length || !deps.every(d => run.nodes[d] && run.nodes[d].status === 'done')) continue
    const taskId = await api.tasks.add(n.title, 'backlog', {
      description: [`[workflow "${wf.name}" · run ${run.id} · node ${n.id}]`, n.description || ''].filter(Boolean).join('\n\n'),
      criteria: n.criteria || [],
      cwd: n.cwd || undefined,
      isolate: n.isolate === true ? true : undefined,
    })
    await api.tasks.start(taskId)
    run.nodes[n.id] = { taskId, status: 'running' }
  }
}

if (Object.values(run.nodes).every(n => n.status === 'done')) {
  run.status = 'done'
  run.finishedAt = Date.now()
  await api.notify('Workflow finished', `"${run.wfName}" — every node is done`)
}

await api.storage.set('runs', runs)
