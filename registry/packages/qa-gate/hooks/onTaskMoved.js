// Fires on every board-column change: (input = { taskId, title, col, from }, api)
// When a task reaches review, spawn an independent auditor one-shot that
// re-verifies the acceptance criteria, and tell the task's watcher about it.
if (input.col !== 'review') return

const state = api.getState()
const task = state.tasks.find(t => t.id === input.taskId)
if (!task) return

// don't stack audits: skip if one is already running for this task
const audits = api.storage.get('audits') || []
if (audits.some(a => a.taskId === task.id && a.verdict === 'running')) return

const criteria = (task.criteria || []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '(none recorded — judge from the description)'
const prompt = [
  'You are an independent QA auditor. Verify whether this task\'s acceptance criteria are ACTUALLY met in the current workspace — run checks and inspect files; never trust claims and never modify anything.',
  `Task: ${task.title}`,
  task.description ? `Description: ${task.description}` : '',
  `Acceptance criteria:\n${criteria}`,
  'Finish with exactly one line "QA VERDICT: pass" or "QA VERDICT: fail — <reason>", preceded by a short evidence list.',
].filter(Boolean).join('\n\n')

const quoted = "'" + prompt.replace(/'/g, "'\\''") + "'"
const sid = api.launchSession(`claude -p --permission-mode plan ${quoted}`, task.cwd || '', `qa·${task.title.slice(0, 14)}`)

api.storage.set('audits', [...audits, {
  taskId: task.id, title: task.title, at: Date.now(),
  sessionId: sid, verdict: sid ? 'running' : 'error', detail: sid ? '' : 'launch failed',
}].slice(-50))

if (sid) {
  api.tasks.chat(task.id, 'QA Gate: an independent auditor session is re-verifying the acceptance criteria. Hold the task in review until its verdict lands here.')
  api.notify('QA Gate', `Auditing "${task.title.slice(0, 50)}"`)
  api.logEvent(`QA audit started for "${task.title.slice(0, 40)}"`)
}
