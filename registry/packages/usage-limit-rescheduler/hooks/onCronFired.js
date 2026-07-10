// (input = { name, kind }, api) — a retry schedule booked by the monitor agent
// came due: the usage limit should have reset, so restart the failed task.
// One-time (at:) schedules disarm themselves after firing; we also clean the
// disarmed entry out of the schedules list.
if (!String(input.name || '').startsWith('retry-')) return

const retries = (await api.storage.get('retries')) || {}
const entry = retries[input.name]
if (!entry) return

const task = await api.tasks.get(entry.taskId)
if (!task) {
  delete retries[input.name]
  await api.storage.set('retries', retries)
  return
}

if (task.col === 'failed') {
  await api.tasks.restart(entry.taskId)
  await api.tasks.chat(entry.taskId, 'Usage-Limit Rescheduler: the limit window has passed — restarting this task now (attempt ' + (entry.attempts || 1) + ').')
  await api.notify('Task rescheduled', '"' + String(entry.title || task.title).slice(0, 60) + '" restarted after the usage-limit window')
} else {
  await api.logEvent('retry ' + input.name + ' skipped — task already moved to ' + task.col)
}

// keep history, drop the pending entry
const history = (await api.storage.get('history')) || []
history.unshift({ at: Date.now(), taskId: entry.taskId, title: entry.title || task.title, attempts: entry.attempts || 1, outcome: task.col === 'failed' ? 'restarted' : 'skipped (' + task.col + ')' })
await api.storage.set('history', history.slice(0, 50))
delete retries[input.name]
await api.storage.set('retries', retries)
await api.schedules.remove(input.name)
