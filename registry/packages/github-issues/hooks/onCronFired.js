// (input = { name, kind }, api) — sync new GitHub issues when our schedule
// fires. New (unseen) open issues land in the review queue; in auto mode the
// triage agent is woken with them instead and decides which become tasks.
if (input.name !== 'github-issues-sync') return

const cfg = (await api.storage.get('config')) || {}
if (!cfg.owner || !cfg.repo) return

// only send the Authorization header when a token is actually stored —
// {{secret:…}} on an unset secret is a hard error by design
const secrets = await api.secrets.list()
const hasToken = secrets.some(s => s.name === 'GITHUB_TOKEN' && s.set)
const headers = { accept: 'application/vnd.github+json' }
if (hasToken) headers.authorization = 'Bearer {{secret:GITHUB_TOKEN}}'

const labels = cfg.labels ? '&labels=' + encodeURIComponent(cfg.labels) : ''
const res = await api.http.request('GET',
  `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/issues?state=open&per_page=50&sort=created&direction=desc${labels}`,
  { headers })
if (res.status !== 200) {
  await api.logEvent(`GitHub sync failed: HTTP ${res.status}`)
  return
}

const seen = (await api.storage.get('seen')) || []
const queue = (await api.storage.get('queue')) || []
const fresh = JSON.parse(res.text)
  .filter(i => !i.pull_request) // the issues endpoint returns PRs too
  .filter(i => !seen.includes(i.number) && !queue.some(q => q.number === i.number))
  .map(i => ({
    number: i.number,
    title: i.title,
    body: (i.body || '').slice(0, 2000),
    labels: (i.labels || []).map(l => l.name),
    url: i.html_url,
    at: Date.now(),
  }))

await api.storage.set('lastSync', { at: Date.now(), found: fresh.length, status: res.status })
if (!fresh.length) return

await api.storage.set('queue', [...queue, ...fresh].slice(-100))

if (cfg.auto) {
  // auto mode: the triage agent reads the batch and files board tasks per its
  // instructions (customize them in this addon's chat)
  await api.agent.wake('New GitHub issues arrived — triage them per your instructions:\n\n'
    + JSON.stringify(fresh.map(f => ({ number: f.number, title: f.title, labels: f.labels, body: f.body.slice(0, 400) })), null, 2))
} else {
  await api.notify('GitHub Issues', `${fresh.length} new issue(s) queued — review them in the GitHub Issues tab`)
}
