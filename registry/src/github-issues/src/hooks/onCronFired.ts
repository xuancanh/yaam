import type { HookHandler } from '@yaam/addon-sdk'

const handler: HookHandler<'onCronFired'> = async (input, api) => {
// (input = { name, kind }, api) — sync every enabled repository when our
// schedule fires. New (unseen) open issues land in the Inbox; in auto mode the
// triage agent is woken with the batch and decides which become tasks.
if (input.name !== 'github-issues-sync') return

const cfg = (await api.storage.get('config')) || {}
// v1 → v2 migration (same rules as the view): single owner/repo becomes the
// repos list; the old review queue becomes inbox records in the issue store.
if (!Array.isArray(cfg.repos)) {
  cfg.repos = (cfg.owner && cfg.repo) ? [{ name: cfg.owner + '/' + cfg.repo, on: true }] : []
  cfg.legacy = cfg.owner && cfg.repo ? cfg.owner + '/' + cfg.repo : ''
  cfg.freq = cfg.schedOn ? (cfg.interval || '*/30 * * * *') : 'manual'
  await api.storage.set('config', cfg)
}
const repos = cfg.repos.filter(r => r.on)
if (!repos.length) return

let issues = (await api.storage.get('issues')) || []
const queue = (await api.storage.get('queue')) || []
if (queue.length) {
  const repo = cfg.legacy || (repos[0] && repos[0].name) || ''
  for (const q of queue) {
    const key = repo + '#' + q.number
    if (!issues.some(i => i.key === key)) {
      issues.push({ key, number: q.number, repo, title: q.title, body: q.body || '', labels: q.labels || [],
        url: q.url, author: '', comments: 0, createdAt: q.at, at: q.at, state: 'inbox', taskId: null })
    }
  }
  await api.storage.remove('queue')
}

// only send the Authorization header when a token is actually stored —
// {{secret:…}} on an unset secret is a hard error by design
const secrets = await api.secrets.list()
const headers = { accept: 'application/vnd.github+json' }
if (secrets.some(s => s.name === 'GITHUB_TOKEN' && s.set)) headers.authorization = 'Bearer {{secret:GITHUB_TOKEN}}'

const seen = (await api.storage.get('seen')) || []
const labels = cfg.labels ? '&labels=' + encodeURIComponent(cfg.labels) : ''
const fresh = []
for (const r of repos) {
  const res = await api.http.request('GET',
    `https://api.github.com/repos/${r.name}/issues?state=open&per_page=50&sort=created&direction=desc${labels}`,
    { headers })
  if (res.status !== 200) {
    await api.logEvent(`GitHub sync failed for ${r.name}: HTTP ${res.status}`)
    continue
  }
  for (const raw of JSON.parse(res.text)) {
    if (raw.pull_request) continue // the issues endpoint returns PRs too
    const key = r.name + '#' + raw.number
    const ex = issues.find(i => i.key === key)
    if (ex) { // refresh live fields on issues we already track
      ex.title = raw.title
      ex.comments = raw.comments || 0
      ex.labels = (raw.labels || []).map(l => l.name)
      continue
    }
    if (r.name === cfg.legacy && seen.includes(raw.number)) continue // handled in v1
    const rec = { key, number: raw.number, repo: r.name, title: raw.title,
      body: (raw.body || '').slice(0, 4000), labels: (raw.labels || []).map(l => l.name),
      url: raw.html_url, author: (raw.user && raw.user.login) || '',
      comments: raw.comments || 0, createdAt: Date.parse(raw.created_at) || Date.now(),
      at: Date.now(), state: 'inbox', taskId: null }
    issues.push(rec)
    fresh.push(rec)
  }
}

await api.storage.set('issues', issues.slice(-300))
await api.storage.set('lastSync', { at: Date.now(), found: fresh.length })
if (!fresh.length) return

if (cfg.auto) {
  // auto mode: the triage agent reads the batch and files board tasks per its
  // instructions (customize them in this addon's chat)
  await api.agent.wake('New GitHub issues arrived — triage them per your instructions:\n\n'
    + JSON.stringify(fresh.map(f => ({ key: f.key, number: f.number, repo: f.repo, title: f.title, labels: f.labels, body: (f.body || '').slice(0, 400) })), null, 2))
} else {
  await api.notify('GitHub Issues', `${fresh.length} new issue(s) in the inbox — review them in the GitHub Issues tab`)
}
}

export default handler
