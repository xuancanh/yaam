import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onTaskMoved'> = async (input, api) => {
// (input = { taskId, title, col, from }, api) — a board task changed column.
// When "close the issue when its task is done" is enabled and the finished
// task is linked to a synced issue, close that issue on GitHub (token in the
// OS keychain; sent only as a templated header, never visible to this code).
if (input.col !== 'done') return

const cfg = (await api.storage.get('config')) || {}
if (!cfg.autoClose) return

const issues = (await api.storage.get('issues')) || []
const iss = issues.find(i => i.state === 'synced' && i.taskId === input.taskId && !i.closed)
if (!iss) return

const secrets = await api.secrets.list()
if (!secrets.some(s => s.name === 'GITHUB_TOKEN' && s.set)) {
  await api.logEvent(`GitHub Issues: cannot close #${iss.number} — no GITHUB_TOKEN stored`)
  return
}
const headers = {
  accept: 'application/vnd.github+json',
  authorization: 'Bearer {{secret:GITHUB_TOKEN}}',
  'content-type': 'application/json',
}

// leave a breadcrumb comment, then close; a failed comment is non-fatal
await api.http.request('POST',
  `https://api.github.com/repos/${iss.repo}/issues/${iss.number}/comments`,
  { headers, body: JSON.stringify({ body: `Resolved by the linked yaam board task: "${String(input.title).slice(0, 120)}".` }) })
  .catch(() => {})
const res = await api.http.request('PATCH',
  `https://api.github.com/repos/${iss.repo}/issues/${iss.number}`,
  { headers, body: JSON.stringify({ state: 'closed' }) })

if (res.status === 200) {
  iss.closed = true
  await api.storage.set('issues', issues)
  await api.notify('GitHub Issues', `Closed ${iss.repo}#${iss.number} — its task reached Done`)
} else {
  await api.logEvent(`GitHub Issues: closing #${iss.number} failed — HTTP ${res.status}`)
}
}

export default handler
