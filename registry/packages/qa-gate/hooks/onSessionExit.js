// Fires when any session exits: (input = { sessionId, name, code }, api)
// If it was one of our auditors, read its final output, record the verdict,
// report to the task's watcher chat, and bounce failing tasks back to work.
const audits = api.storage.get('audits') || []
const idx = audits.findIndex(a => a.sessionId === input.sessionId && a.verdict === 'running')
if (idx < 0) return

const out = api.sessions.readOutput(input.sessionId, 60)
const m = out.match(/QA VERDICT:\s*(pass|fail)\s*(?:[—-]\s*)?([^\n]*)/i)
const verdict = m ? m[1].toLowerCase() : (input.code === 0 ? 'unclear' : 'error')
const detail = m && m[2] ? m[2].trim() : ''

audits[idx] = { ...audits[idx], verdict, detail, doneAt: Date.now() }
api.storage.set('audits', audits)

const a = audits[idx]
const line = verdict === 'pass'
  ? 'QA Gate verdict: PASS — criteria independently verified. Safe to mark done.'
  : verdict === 'fail'
    ? `QA Gate verdict: FAIL — ${detail || 'see the auditor session output'}. Moving back to In progress; please address the findings.`
    : `QA Gate: the auditor exited without a clear verdict (${verdict}). Check its session output.`
api.tasks.chat(a.taskId, line)
api.notify(`QA ${verdict.toUpperCase()}`, a.title.slice(0, 60))
api.logEvent(`QA ${verdict} for "${a.title.slice(0, 40)}"`)
if (verdict === 'fail') api.tasks.move(a.taskId, 'progress')
