import type { ToolHandler } from '@yaam/addon-sdk'

const handler: ToolHandler = async (input, api) => {
// Master tool: (input = { task_id }, api) → string
// Manual audit trigger — same auditor the review gate spawns.
const state = api.getState()
const task = state.tasks.find(t => t.id === input.task_id)
if (!task) return `no board task with id ${input.task_id}`

const audits = api.storage.get('audits') || []
if (audits.some(a => a.taskId === task.id && a.verdict === 'running')) return 'an audit is already running for that task'

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
if (!sid) return 'failed to launch the auditor session'

api.storage.set('audits', [...audits, { taskId: task.id, title: task.title, at: Date.now(), sessionId: sid, verdict: 'running', detail: '' }].slice(-50))
api.tasks.chat(task.id, 'QA Gate: a manual audit was requested — the auditor session is re-verifying the acceptance criteria now.')
return `auditor session started for "${task.title}" — the verdict will be posted to the task chat and recorded in qa_history`
}

export default handler
