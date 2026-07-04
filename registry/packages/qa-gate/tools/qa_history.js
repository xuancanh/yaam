// Master tool: (input = { limit? }, api) → string
const audits = (api.storage.get('audits') || []).slice().reverse()
const limit = Math.max(1, Math.min(50, Number(input.limit) || 10))
if (!audits.length) return 'No QA audits recorded yet — audits run automatically when a task reaches review.'
return audits.slice(0, limit).map(a => {
  const when = new Date(a.at).toLocaleString()
  return `${a.verdict.toUpperCase().padEnd(7)} ${when} · "${a.title}"${a.detail ? ` — ${a.detail}` : ''}`
}).join('\n')
