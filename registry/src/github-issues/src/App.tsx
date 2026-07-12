import { useCallback, useEffect, useRef, useState } from 'react'
import { useYaam, useYaamState } from '@yaam/addon-sdk/react'
import type { SnapshotTask } from '@yaam/addon-sdk'

// ---------------- model ----------------
type IssueState = 'inbox' | 'synced' | 'ignored' | 'archived'
interface Issue {
  key: string; number: number; repo: string; title: string; body: string
  labels: string[]; url: string; author: string; comments: number
  createdAt: number; at: number; state: IssueState; taskId: string | null; closed?: boolean
}
interface RepoCfg { name: string; on: boolean }
interface Config {
  repos?: RepoCfg[]; legacy?: string; freq?: string; labels?: string; cwd?: string
  startOnSpawn?: boolean; auto?: boolean; autostart?: boolean; autoClose?: boolean
  owner?: string; repo?: string; schedOn?: boolean; interval?: string
}
interface LastSync { at: number; found: number }
interface GhComment { user?: { login?: string }; body?: string; created_at?: string }

type SortKey = 'newest' | 'oldest' | 'comments' | 'number'
const PAGE = 8
const SCHED = 'github-issues-sync'
const COLSTAT: Record<string, { l: string; c: string }> = {
  backlog: { l: 'Queued', c: '#6B7280' }, progress: { l: 'In progress', c: '#3DDC97' },
  review: { l: 'In review', c: '#FFB020' }, done: { l: 'Done', c: '#A371F7' }, failed: { l: 'Failed', c: '#FF5C5C' },
}
const SORTS: [SortKey, string][] = [['newest', 'Newest'], ['oldest', 'Oldest'], ['comments', 'Most comments'], ['number', 'Issue number']]

// ---------------- helpers ----------------
const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'
}
function lblColor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h},55%,68%)`
}
const mix = (c: string, pct: number) => `color-mix(in srgb,${c} ${pct}%,transparent)`

// v1 → v2 migration: single owner/repo + queue/seen become the repos list and
// the unified issue store. Runs in the view and (same logic) in the sync hook.
function migrate(cfg: Config): [Config, boolean] {
  if (!Array.isArray(cfg.repos)) {
    const c: Config = { ...cfg }
    c.repos = (c.owner && c.repo) ? [{ name: c.owner + '/' + c.repo, on: true }] : []
    c.legacy = c.owner && c.repo ? c.owner + '/' + c.repo : ''
    c.freq = c.schedOn ? (c.interval || '*/30 * * * *') : 'manual'
    return [c, true]
  }
  return [cfg, false]
}

const GithubMark = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#E7E9F0"><path d="M12 2C6.5 2 2 6.6 2 12.3c0 4.5 2.9 8.4 6.8 9.7.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 015 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5a10.3 10.3 0 006.8-9.7C22 6.6 17.5 2 12 2z" /></svg>
)

function StateIcon({ it }: { it: Issue }) {
  const closed = !!it.closed
  const c = closed ? '#A371F7' : '#3DDC97'
  return (
    <span className="stico" style={{ background: mix(c, 10) }}>
      {closed
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12.2l2.4 2.4 4.4-4.8" /></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.9"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.4" fill={c} stroke="none" /></svg>}
    </span>
  )
}
const LabelPills = ({ labels }: { labels: string[] }) => (
  <>{(labels || []).map(l => {
    const c = lblColor(l)
    return <span key={l} className="pill" style={{ color: c, borderColor: mix(c, 30), background: mix(c, 12) }}><span className="d" style={{ background: c }} />{l}</span>
  })}</>
)
function StatePill({ it }: { it: Issue }) {
  const closed = !!it.closed
  const c = closed ? 'var(--purple)' : 'var(--green)'
  return <span className="state" style={{ color: c, background: closed ? 'rgba(163,113,247,.14)' : 'rgba(61,220,151,.14)' }}><span className="d" style={{ background: c }} />{closed ? 'Closed' : 'Open'}</span>
}
const ColStatePill = ({ st }: { st: { l: string; c: string } }) => (
  <span className="state" style={{ color: st.c, background: mix(st.c, 14) }}><span className="d" style={{ background: st.c }} />{st.l}</span>
)

// ---------------- app ----------------
export function App() {
  const yaam = useYaam()
  const api = yaam.api
  const snap = useYaamState()

  const [cfg, setCfg] = useState<Config>({})
  const [issues, setIssues] = useState<Issue[]>([])
  const [tokenSet, setTokenSet] = useState(false)
  const [lastSync, setLastSync] = useState<LastSync | null>(null)
  const [banner, setBannerState] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const [mode, setMode] = useState<'issues' | 'settings'>('issues')
  const [tab, setTab] = useState<IssueState>('inbox')
  const [repoSel, setRepoSel] = useState('all')
  const [q, setQ] = useState('')
  const [label, setLabel] = useState('all')
  const [sort, setSort] = useState<SortKey>('newest')
  const [page, setPage] = useState(1)
  const [menu, setMenu] = useState<'label' | 'sort' | null>(null)
  const [detail, setDetail] = useState<string | null>(null)

  const bannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showBanner = useCallback((msg: string) => {
    setBannerState(/permission "/.test(msg) ? msg + ' — grant it in the Addons view, then retry.' : msg)
    clearTimeout(bannerTimer.current)
    bannerTimer.current = setTimeout(() => setBannerState(null), 7000)
  }, [])

  const persistIssues = useCallback(async (next: Issue[]) => {
    setIssues(next)
    try { await api.storage.set('issues', next.slice(-300)) } catch (e) { showBanner((e as Error).message) }
  }, [api, showBanner])
  const saveCfg = useCallback(async (next: Config) => {
    setCfg(next)
    try { await api.storage.set('config', next) } catch (e) { showBanner((e as Error).message) }
  }, [api, showBanner])

  // ---- initial load ----
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        let c = ((await api.storage.get('config')) as Config) || {}
        let iss = ((await api.storage.get('issues')) as Issue[]) || []
        const [migrated, dirty] = migrate(c)
        c = migrated
        if (dirty) await api.storage.set('config', c)
        const queue = ((await api.storage.get('queue')) as { number: number; title: string; body?: string; labels?: string[]; url: string; at: number }[]) || []
        if (queue.length) {
          const repo = c.legacy || (c.repos && c.repos[0] && c.repos[0].name) || ''
          iss = iss.slice()
          for (const it of queue) {
            const key = repo + '#' + it.number
            if (!iss.some(i => i.key === key)) {
              iss.push({ key, number: it.number, repo, title: it.title, body: it.body || '', labels: it.labels || [], url: it.url, author: '', comments: 0, createdAt: it.at, at: it.at, state: 'inbox', taskId: null })
            }
          }
          await api.storage.set('issues', iss)
          await api.storage.remove('queue')
        }
        if (!alive) return
        setCfg(c); setIssues(iss)
      } catch (e) { if (alive) showBanner((e as Error).message) }
      try {
        const secrets = await api.secrets.list()
        if (alive) setTokenSet(!!secrets.find(s => s.name === 'GITHUB_TOKEN' && s.set))
      } catch { /* secrets scope not granted */ }
      try { const last = (await api.storage.get('lastSync')) as LastSync | null; if (alive) setLastSync(last) } catch { /* storage denied */ }
    })()
    return () => { alive = false }
  }, [api, showBanner])

  // ---- on every state push (~3s): re-pull lastSync + issues (the sync hook may
  //      have added issues in the background) ----
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const last = (await api.storage.get('lastSync')) as LastSync | null
        const iss = (await api.storage.get('issues')) as Issue[] | null
        if (!alive) return
        setLastSync(last)
        if (iss) setIssues(iss)
      } catch { /* storage denied */ }
    })()
    return () => { alive = false }
  }, [snap, api])

  // ---- global dismiss: click closes an open menu; Escape closes menu+drawer ----
  useEffect(() => {
    const onClick = () => setMenu(m => (m ? null : m))
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { setMenu(null); setDetail(null) } }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey) }
  }, [])

  // ---------------- derived ----------------
  const taskOf = useCallback((i: Issue): SnapshotTask | null =>
    (i.taskId && snap && snap.tasks) ? (snap.tasks.find(t => t.id === i.taskId) ?? null) : null, [snap])

  const filtered = useCallback(() => {
    const needle = q.trim().toLowerCase()
    return issues.filter(i => repoSel === 'all' || i.repo === repoSel)
      .filter(i => !needle || i.title.toLowerCase().includes(needle) || ('#' + i.number).includes(needle) || i.repo.toLowerCase().includes(needle) || (i.author || '').toLowerCase().includes(needle))
      .filter(i => label === 'all' || (i.labels || []).includes(label))
  }, [issues, repoSel, q, label])

  const sorted = (list: Issue[]) => {
    const by: Record<SortKey, (a: Issue, b: Issue) => number> = {
      newest: (a, b) => (b.createdAt || b.at) - (a.createdAt || a.at),
      oldest: (a, b) => (a.createdAt || a.at) - (b.createdAt || b.at),
      comments: (a, b) => (b.comments || 0) - (a.comments || 0),
      number: (a, b) => b.number - a.number,
    }
    return list.slice().sort(by[sort] || by.newest)
  }

  // ---------------- issue actions ----------------
  const ghHeaders = useCallback(() => {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
    if (tokenSet) headers.authorization = 'Bearer {{secret:GITHUB_TOKEN}}'
    return headers
  }, [tokenSet])

  async function spawnTask(key: string) {
    const it = issues.find(i => i.key === key); if (!it) return
    setBusyKey(key)
    try {
      const taskId = await api.tasks.add(('#' + it.number + ' · ' + it.title).slice(0, 120), 'backlog', {
        description: (it.body || '') + '\n\n' + it.url,
        cwd: cfg.cwd || undefined,
      })
      await persistIssues(issues.map(i => i.key === key ? { ...i, state: 'synced', taskId } : i))
      if (cfg.startOnSpawn) await api.tasks.start(taskId)
      await api.flash('task spawned for #' + it.number)
    } catch (e) { showBanner((e as Error).message) }
    setBusyKey(null)
  }
  async function setIssueState(key: string, state: IssueState, note?: string) {
    const next = issues.map(i => i.key === key ? { ...i, state, taskId: state !== 'synced' ? null : i.taskId } : i)
    await persistIssues(next)
    if (note) { try { await api.flash(note) } catch { /* ui denied */ } }
  }
  async function openInBoard(taskId: string) { try { await api.focusTask(taskId) } catch (e) { showBanner((e as Error).message) } }
  async function startLinked(taskId: string) { try { await api.tasks.start(taskId); await api.flash('task started') } catch (e) { showBanner((e as Error).message) } }

  // ---------------- sync ----------------
  async function syncNow() {
    const repos = (cfg.repos || []).filter(r => r.on)
    if (!repos.length) { showBanner('add a repository in Settings first'); setMode('settings'); return }
    setSyncing(true)
    let found = 0
    const fresh: Issue[] = []
    const next = issues.slice()
    try {
      const seen = ((await api.storage.get('seen')) as number[]) || []
      for (const r of repos) {
        const labels = cfg.labels ? '&labels=' + encodeURIComponent(cfg.labels) : ''
        const res = await api.http.request('GET',
          'https://api.github.com/repos/' + r.name + '/issues?state=open&per_page=50&sort=created&direction=desc' + labels,
          { headers: ghHeaders() })
        if (res.status === 404) { showBanner(r.name + ': not found (private without a token?)'); continue }
        if (res.status !== 200) { showBanner(r.name + ': GitHub replied HTTP ' + res.status); continue }
        for (const raw of JSON.parse(res.text) as Record<string, unknown>[]) {
          if (raw.pull_request) continue
          const num = raw.number as number
          const key = r.name + '#' + num
          const ex = next.find(i => i.key === key)
          if (ex) {
            ex.title = raw.title as string; ex.comments = (raw.comments as number) || 0
            ex.labels = ((raw.labels as { name: string }[]) || []).map(l => l.name)
            continue
          }
          if (r.name === cfg.legacy && seen.includes(num)) continue
          const rec: Issue = {
            key, number: num, repo: r.name, title: raw.title as string,
            body: ((raw.body as string) || '').slice(0, 4000), labels: ((raw.labels as { name: string }[]) || []).map(l => l.name),
            url: raw.html_url as string, author: ((raw.user as { login?: string })?.login) || '',
            comments: (raw.comments as number) || 0, createdAt: Date.parse(raw.created_at as string) || Date.now(),
            at: Date.now(), state: 'inbox', taskId: null,
          }
          next.push(rec); fresh.push(rec); found++
        }
      }
      await persistIssues(next)
      await api.storage.set('lastSync', { at: Date.now(), found })
      setLastSync({ at: Date.now(), found })
      await api.flash(found ? found + ' new issue(s) in the inbox' : 'no new issues')
      if (fresh.length && cfg.auto) {
        await api.agent.wake('New GitHub issues arrived — triage them per your instructions:\n\n'
          + JSON.stringify(fresh.map(f => ({ key: f.key, number: f.number, repo: f.repo, title: f.title, labels: f.labels, body: (f.body || '').slice(0, 400) })), null, 2))
      }
    } catch (e) { showBanner((e as Error).message) }
    setSyncing(false)
  }

  // ---------------- settings actions ----------------
  async function addRepo(raw: string) {
    const name = raw.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) { showBanner('use the owner/repository form, e.g. anthropics/claude-code'); return false }
    if ((cfg.repos || []).some(r => r.name.toLowerCase() === name.toLowerCase())) { showBanner('already in the list'); return false }
    await saveCfg({ ...cfg, repos: (cfg.repos || []).concat([{ name, on: true }]) })
    return true
  }
  const toggleRepo = (name: string) => saveCfg({ ...cfg, repos: (cfg.repos || []).map(r => r.name === name ? { ...r, on: !r.on } : r) })
  async function removeRepo(name: string) {
    if (repoSel === name) setRepoSel('all')
    await saveCfg({ ...cfg, repos: (cfg.repos || []).filter(r => r.name !== name) })
  }
  async function setFreq(v: string) {
    try {
      await api.schedules.remove(SCHED).catch(() => {})
      if (v !== 'manual') await api.schedules.add({ name: SCHED, schedule: v })
    } catch (e) { showBanner((e as Error).message); return }
    await saveCfg({ ...cfg, freq: v })
  }
  const toggleCfg = (k: keyof Config) => saveCfg({ ...cfg, [k]: !cfg[k] })

  // ---------------- render ----------------
  const lastLbl = lastSync ? 'Last synced ' + ago(lastSync.at) : 'Never synced'
  return (
    <>
      <div id="topbar">
        <GithubMark size={19} />
        <span className="title">GitHub Issues</span>
        <div className="seg">
          <button className={mode === 'issues' ? 'on' : ''} onClick={() => setMode('issues')}>Issues</button>
          <button className={mode === 'settings' ? 'on' : ''} onClick={() => setMode('settings')}>Settings</button>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>{lastLbl}</span>
        <button className="btn" disabled={syncing} onClick={syncNow}><span className={syncing ? 'spin' : ''}>⟳</span> Sync now</button>
      </div>
      {banner && <div id="banner">{banner}</div>}

      {mode === 'issues'
        ? <IssuesPage {...{ cfg, issues, snap, tab, setTab, repoSel, setRepoSel, q, setQ, label, setLabel, sort, setSort, page, setPage, menu, setMenu, filtered, sorted, taskOf, busyKey, spawnTask, setIssueState, openInBoard, startLinked, setMode, openDetail: setDetail }} />
        : <SettingsPage {...{ cfg, issues, tokenSet, saveCfg, addRepo, toggleRepo, removeRepo, setFreq, toggleCfg, api, showBanner }} />}

      {detail && <DetailDrawer {...{ issue: issues.find(i => i.key === detail)!, taskOf, ghHeaders, api, close: () => setDetail(null), busyKey, spawnTask, setIssueState, openInBoard, startLinked }} />}
    </>
  )
}

// ================= Issues page =================
interface IssuesProps {
  cfg: Config; issues: Issue[]; snap: ReturnType<typeof useYaamState>
  tab: IssueState; setTab: (t: IssueState) => void
  repoSel: string; setRepoSel: (r: string) => void
  q: string; setQ: (s: string) => void
  label: string; setLabel: (l: string) => void
  sort: SortKey; setSort: (s: SortKey) => void
  page: number; setPage: (p: number) => void
  menu: 'label' | 'sort' | null; setMenu: (m: 'label' | 'sort' | null) => void
  filtered: () => Issue[]; sorted: (l: Issue[]) => Issue[]; taskOf: (i: Issue) => SnapshotTask | null
  busyKey: string | null
  spawnTask: (k: string) => void; setIssueState: (k: string, s: IssueState, n?: string) => void
  openInBoard: (id: string) => void; startLinked: (id: string) => void
  setMode: (m: 'issues' | 'settings') => void; openDetail: (k: string) => void
}
function IssuesPage(p: IssuesProps) {
  const base = p.filtered()
  const counts: Record<string, number> = { inbox: 0, synced: 0, ignored: 0, archived: 0 }
  for (const i of base) counts[i.state] = (counts[i.state] || 0) + 1

  const list = p.sorted(base.filter(i => i.state === p.tab))
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const page = Math.min(Math.max(1, p.page), pages)
  const slice = list.slice((page - 1) * PAGE, page * PAGE)

  const labelNames = ['all'].concat(Object.keys(Object.fromEntries((p.issues.flatMap(i => i.labels || [])).map(l => [l, 1]))).sort())
  const repoNames = ['all'].concat((p.cfg.repos || []).filter(r => r.on).map(r => r.name))
  const emptyMsg: Record<string, string> = {
    inbox: (p.cfg.repos || []).some(r => r.on) ? 'No new issues to triage. Everything in scope is synced or filed away.' : 'Add a repository in Settings, then hit ⟳ Sync now.',
    synced: 'No issues are linked to a task yet. Spawn one from the Inbox.',
    ignored: 'Nothing ignored.', archived: 'Nothing archived.',
  }

  return (
    <div id="pgIssues" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div id="tabRow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {([['inbox', 'Inbox'], ['synced', 'Synced'], ['ignored', 'Ignored'], ['archived', 'Archived']] as [IssueState, string][]).map(([k, lbl]) => (
            <button key={k} className={'cattab' + (p.tab === k ? ' on' : '')} onClick={() => { p.setTab(k); p.setPage(1) }}>{lbl} <span className="n">{counts[k] || 0}</span></button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <div id="repoChips">
          <span className="lbl">repo</span>
          {repoNames.map(n => (
            <button key={n} className={'rchip' + (p.repoSel === n ? ' on' : '')} title={n} onClick={() => { p.setRepoSel(n); p.setPage(1) }}>{n === 'all' ? 'All repos' : (n.split('/')[1] || n)}</button>
          ))}
        </div>
      </div>

      <div id="filterRow">
        <div id="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#626B79" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>
          <input value={p.q} placeholder="Search issues, #number, repo, author…" onChange={e => { p.setQ(e.target.value); p.setPage(1) }} />
        </div>
        <span style={{ flex: 1 }} />
        <div className="drop">
          <button className="dropbtn" onClick={e => { e.stopPropagation(); p.setMenu(p.menu === 'label' ? null : 'label') }}><span className="k">Label:</span> <span>{p.label === 'all' ? 'All labels' : p.label}</span> ▾</button>
          <div className={'menu' + (p.menu === 'label' ? ' open' : '')}>
            {labelNames.map(name => {
              const c = name === 'all' ? '#3a4150' : lblColor(name)
              return <button key={name} className={p.label === name ? 'on' : ''} onClick={e => { e.stopPropagation(); p.setLabel(name); p.setMenu(null); p.setPage(1) }}><span className="sw" style={{ background: c }} /><span style={{ flex: 1 }}>{name === 'all' ? 'All labels' : name}</span>{p.label === name ? '✓' : ''}</button>
            })}
          </div>
        </div>
        <div className="drop">
          <button className="dropbtn" onClick={e => { e.stopPropagation(); p.setMenu(p.menu === 'sort' ? null : 'sort') }}><span className="k">Sort:</span> <span>{SORTS.find(s => s[0] === p.sort)![1]}</span> ▾</button>
          <div className={'menu' + (p.menu === 'sort' ? ' open' : '')}>
            {SORTS.map(([k, lbl]) => (
              <button key={k} className={p.sort === k ? 'on' : ''} onClick={e => { e.stopPropagation(); p.setSort(k); p.setMenu(null); p.setPage(1) }}><span style={{ flex: 1 }}>{lbl}</span>{p.sort === k ? '✓' : ''}</button>
            ))}
          </div>
        </div>
      </div>

      <div id="list">
        {slice.map(it => <IssueCard key={it.key} {...{ it, taskOf: p.taskOf, busyKey: p.busyKey, spawnTask: p.spawnTask, setIssueState: p.setIssueState, openInBoard: p.openInBoard, startLinked: p.startLinked, openDetail: p.openDetail }} />)}
        {!list.length && (
          <div className="empty">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#3a4150" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" fill="#3a4150" stroke="none" /></svg>
            <span>{emptyMsg[p.tab]}</span>
          </div>
        )}
      </div>

      {pages > 1 && (
        <div id="pager">
          <span className="info">{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, list.length)} of {list.length}</span>
          <span style={{ flex: 1 }} />
          {Array.from({ length: pages }, (_, i) => i + 1).map(pn => (
            <button key={pn} className={'pgn' + (pn === page ? ' on' : '')} onClick={() => p.setPage(pn)}>{pn}</button>
          ))}
        </div>
      )}
    </div>
  )
}

interface CardProps {
  it: Issue; taskOf: (i: Issue) => SnapshotTask | null; busyKey: string | null
  spawnTask: (k: string) => void; setIssueState: (k: string, s: IssueState, n?: string) => void
  openInBoard: (id: string) => void; startLinked: (id: string) => void; openDetail: (k: string) => void
}
function IssueCard({ it, taskOf, busyKey, spawnTask, setIssueState, openInBoard, startLinked, openDetail }: CardProps) {
  const dim = it.state === 'ignored' || it.state === 'archived'
  const stripe = it.closed ? '#A371F7' : dim ? '#3a4150' : '#3DDC97'
  const t = it.state === 'synced' ? taskOf(it) : null
  const st = t ? (COLSTAT[t.col] || COLSTAT.backlog) : null
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  return (
    <div className={'iss' + (dim ? ' dim' : '')} style={{ ['--stripe' as string]: stripe }} onClick={() => openDetail(it.key)}>
      <StateIcon it={it} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ttl"><span className="tt">{it.title}</span><LabelPills labels={it.labels} /></div>
        <div className="meta">
          <span className="num">#{it.number}</span>
          <span className="rp">{it.repo.split('/')[1] || it.repo}</span>
          <span>{(it.author ? it.author + ' · ' : '') + ago(it.createdAt || it.at)}</span>
          {!!(it.comments || 0) && <span>💬 {it.comments}</span>}
          {t ? <span className="lk">→ {t.title}</span> : it.state === 'synced' ? <span className="lk">→ linked task is gone — unlink to triage again</span> : null}
          {it.state === 'ignored' ? <span>· ignored</span> : it.state === 'archived' ? <span>· archived</span> : null}
        </div>
      </div>
      <div className="act" onClick={stop}>
        {it.state === 'inbox' ? <>
          <button className="btn accent sm" disabled={busyKey === it.key} title="Create a linked board task" onClick={() => spawnTask(it.key)}>{busyKey === it.key ? 'Spawning…' : '⇥ Spawn'}</button>
          <button className="btn quiet sm" onClick={() => setIssueState(it.key, 'ignored', 'issue ignored')}>Ignore</button>
          <button className="btn quiet sm" onClick={() => setIssueState(it.key, 'archived', 'issue archived')}>Archive</button>
        </> : it.state === 'synced' ? <>
          {st && <>
            <ColStatePill st={st} />
            {t!.col === 'backlog' && <button className="btn quiet sm" title="Start the linked task" onClick={() => startLinked(it.taskId!)}>▶</button>}
            <button className="btn quiet sm" title="Open the task on the board" onClick={() => openInBoard(it.taskId!)}>Board</button>
          </>}
          <button className="btn quiet danger sm" onClick={() => setIssueState(it.key, 'inbox', 'unlinked — back in the inbox')}>Unlink</button>
        </> : <button className="btn quiet sm" onClick={() => setIssueState(it.key, 'inbox', 'restored to inbox')}><span style={{ color: 'var(--acc)' }}>Restore</span></button>}
      </div>
    </div>
  )
}

// ================= Settings page =================
interface SettingsProps {
  cfg: Config; issues: Issue[]; tokenSet: boolean
  saveCfg: (c: Config) => Promise<void>
  addRepo: (raw: string) => Promise<boolean>; toggleRepo: (n: string) => void; removeRepo: (n: string) => void
  setFreq: (v: string) => void; toggleCfg: (k: keyof Config) => void
  api: ReturnType<typeof useYaam>['api']; showBanner: (m: string) => void
}
function SettingsPage(p: SettingsProps) {
  const [newRepo, setNewRepo] = useState('')
  const [labels, setLabels] = useState(p.cfg.labels || '')
  const [cwd, setCwd] = useState(p.cfg.cwd || '')
  const [tri, setTri] = useState<string[]>([])

  useEffect(() => { setLabels(p.cfg.labels || ''); setCwd(p.cfg.cwd || '') }, [p.cfg.labels, p.cfg.cwd])
  useEffect(() => {
    let alive = true
    p.api.storage.get('triageLog').then(v => { if (alive) setTri((v as string[]) || []) }).catch(() => {})
    return () => { alive = false }
  }, [p.api])

  const repos = p.cfg.repos || []
  const freqs: [string, string][] = [['manual', 'Manual'], ['*/15 * * * *', 'Every 15 min'], ['*/30 * * * *', 'Every 30 min'], ['0 * * * *', 'Hourly']]
  const toggles: [keyof Config, string, string][] = [
    ['startOnSpawn', 'Start spawned tasks immediately', 'Spawn task launches the one-shot session right away instead of parking the task in Backlog.'],
    ['auto', 'Auto-triage new issues', "The addon's agent reviews each newly-synced batch and files tasks itself. Refine its policy in the Customize chat."],
    ['autostart', 'Agent may also start tasks', 'Allow the triage agent to launch the tasks it files, not just create them.'],
    ['autoClose', 'Close the issue when its task is done', 'When a linked task reaches Done, the issue is closed on GitHub (needs a token with repo scope).'],
  ]
  const submitRepo = async () => { if (await p.addRepo(newRepo)) setNewRepo('') }
  const saveInputs = () => p.saveCfg({ ...p.cfg, labels: labels.trim(), cwd: cwd.trim() })

  return (
    <div id="pgSettings">
      <div className="wrap">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }} className="shead">Repositories
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--acc)', background: 'var(--accsoft)', borderRadius: 6, padding: '2px 8px', fontWeight: 500 }}>{repos.filter(r => r.on).length} syncing</span></div>
          <div className="ssub">Which repositories the sync pulls open issues from. Toggle any repo on or off; issues already tracked stay put.</div>
          <div className="scard">
            <div>
              {repos.map(r => {
                const open = p.issues.filter(i => i.repo === r.name && i.state !== 'archived').length
                return (
                  <div key={r.name} className="srow">
                    <span className={'rdot' + (r.on ? ' on' : '')} />
                    <span className="reponame" style={{ flex: 1, color: r.on ? 'var(--text)' : 'var(--mut)' }}>{r.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: "'JetBrains Mono',monospace" }}>{open} tracked</span>
                    <button className={'sw' + (r.on ? ' on' : '')} onClick={() => p.toggleRepo(r.name)}><i /></button>
                    <button className="btn quiet danger" title="Remove repository" onClick={() => p.removeRepo(r.name)}>✕</button>
                  </div>
                )
              })}
              {!repos.length && <div className="srow"><span className="dimnote">No repositories yet — add one below to start syncing.</span></div>}
            </div>
            <div className="addrow">
              <input value={newRepo} placeholder="owner/repository" spellCheck={false} onChange={e => setNewRepo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submitRepo() }} />
              <button className="btn" onClick={submitRepo}>＋ Add</button>
            </div>
          </div>
        </div>

        <div>
          <div className="shead">Sync behavior</div>
          <div className="ssub">{p.tokenSet
            ? <><span style={{ color: 'var(--green)' }}>●</span> GITHUB_TOKEN is set — private repos sync, and closing issues on Done works.</>
            : <><span style={{ color: 'var(--amber)' }}>●</span> No token — public repos only; set GITHUB_TOKEN in the Addons view to sync private repos or close issues.</>}</div>
          <div className="scard">
            <div className="srow">
              <div className="g"><div className="t">Sync frequency</div><div className="d">How often new and updated issues are pulled. Runs as a schedule; Manual only syncs on the button.</div></div>
              <div className="optrow">
                {freqs.map(([v, lbl]) => <button key={v} className={'opt' + ((p.cfg.freq || 'manual') === v ? ' on' : '')} onClick={() => p.setFreq(v)}>{lbl}</button>)}
              </div>
            </div>
            <div className="srow">
              <div className="g"><div className="t">Label filter</div><div className="d">Only sync issues carrying one of these labels (comma-separated). Blank = all issues.</div></div>
              <div className="field" style={{ width: 220 }}><input value={labels} placeholder="bug,help wanted" onChange={e => setLabels(e.target.value)} onBlur={saveInputs} /></div>
            </div>
            <div className="srow">
              <div className="g"><div className="t">Workdir for spawned tasks</div><div className="d">Local checkout where spawned tasks run. Blank = the workspace default.</div></div>
              <div className="field" style={{ width: 220 }}><input value={cwd} placeholder="(workspace default)" onChange={e => setCwd(e.target.value)} onBlur={saveInputs} /></div>
            </div>
            {toggles.map(([k, t, d]) => (
              <div key={k} className="srow">
                <div className="g"><div className="t">{t}</div><div className="d">{d}</div></div>
                <button className={'sw' + (p.cfg[k] ? ' on' : '')} onClick={() => p.toggleCfg(k)}><i /></button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="shead">Agent triage log</div>
          <div className="ssub">What the auto-triage agent decided, newest first. Refine its policy in this addon's Customize chat.</div>
          <div className="scard"><div id="triLog">{tri.length ? tri.map((t, i) => <div key={i}>{t}</div>) : <span className="dimnote">the agent has not triaged anything yet — turn on auto-triage above</span>}</div></div>
        </div>
      </div>
    </div>
  )
}

// ================= Detail drawer =================
interface DrawerProps {
  issue: Issue; taskOf: (i: Issue) => SnapshotTask | null
  ghHeaders: () => Record<string, string>; api: ReturnType<typeof useYaam>['api']
  close: () => void; busyKey: string | null
  spawnTask: (k: string) => void; setIssueState: (k: string, s: IssueState, n?: string) => void
  openInBoard: (id: string) => void; startLinked: (id: string) => void
}
function DetailDrawer({ issue: it, taskOf, ghHeaders, api, close, busyKey, spawnTask, setIssueState, openInBoard, startLinked }: DrawerProps) {
  const [comments, setComments] = useState<{ loading: boolean; err?: string; list?: GhComment[] }>({ loading: it.comments > 0 })

  useEffect(() => {
    if (!(it.comments > 0)) { setComments({ loading: false, list: [] }); return }
    let alive = true
    setComments({ loading: true })
    ;(async () => {
      try {
        const res = await api.http.request('GET', 'https://api.github.com/repos/' + it.repo + '/issues/' + it.number + '/comments?per_page=10', { headers: ghHeaders() })
        if (!alive) return
        if (res.status !== 200) throw new Error('HTTP ' + res.status)
        setComments({ loading: false, list: JSON.parse(res.text) as GhComment[] })
      } catch (e) { if (alive) setComments({ loading: false, err: (e as Error).message }) }
    })()
    return () => { alive = false }
  }, [it.key, it.comments, it.repo, it.number, api, ghHeaders])

  const t = it.state === 'synced' ? taskOf(it) : null
  return (
    <>
      <div id="veil" onClick={close} />
      <div id="detail">
        <div id="dHead">
          <GithubMark size={17} />
          <div style={{ flex: 1, minWidth: 0 }}><div className="k">Issue detail</div><div className="s">{it.repo + ' · #' + it.number}</div></div>
          <a className="btn" href={it.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Open on GitHub ↗</a>
          <button className="x" onClick={close}>✕</button>
        </div>
        <div id="dBody">
          <div className="ttl">{it.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, flexWrap: 'wrap' }}>
            <StatePill it={it} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>{(it.author ? 'opened by ' + it.author + ' · ' : '') + ago(it.createdAt || it.at) + ' · 💬 ' + (it.comments || 0)}</span>
          </div>
          <div className="lblrow"><LabelPills labels={it.labels} /></div>
          <div className="dcard">{it.body ? it.body : <i>No description provided.</i>}</div>
          <div>
            {it.comments > 0 && (comments.loading
              ? <><div className="chead">Comments</div><div className="dimnote">loading…</div></>
              : comments.err
                ? <><div className="chead">Comments</div><div className="dimnote">could not load comments — {comments.err}</div></>
                : <>
                  <div className="chead">{(comments.list || []).length} comment(s)</div>
                  {(comments.list || []).map((c, i) => {
                    const who = (c.user && c.user.login) || '?'
                    return (
                      <div key={i} className="cmt">
                        <span className="av">{who.slice(0, 2).toUpperCase()}</span>
                        <div className="bub"><span className="who">{who}</span><span className="when">{ago(Date.parse(c.created_at || '') || Date.now())}</span><div style={{ marginTop: 4 }}>{(c.body || '').slice(0, 2000)}</div></div>
                      </div>
                    )
                  })}
                </>)}
          </div>
        </div>
        <div id="dFoot">
          {it.state === 'inbox' ? <>
            <button className="btn accent" disabled={busyKey === it.key} onClick={() => spawnTask(it.key)}>{busyKey === it.key ? 'Spawning…' : '⇥ Spawn task'}</button>
            <span style={{ flex: 1 }} />
            <button className="btn quiet" onClick={() => setIssueState(it.key, 'ignored', 'issue ignored')}>Ignore</button>
            <button className="btn quiet" onClick={() => setIssueState(it.key, 'archived', 'issue archived')}>Archive</button>
          </> : it.state === 'synced' ? <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flexWrap: 'wrap' }}>
              {t ? <>
                <span style={{ fontSize: 11, color: 'var(--dim)', fontFamily: "'JetBrains Mono',monospace" }}>linked task</span>
                <span className="linkchip"><span>{t.title}</span></span>
                <ColStatePill st={COLSTAT[t.col] || COLSTAT.backlog} />
              </> : <span className="dimnote">linked task is gone — unlink to triage again</span>}
            </div>
            <span style={{ flex: 1 }} />
            {t && t.col === 'backlog' && <button className="btn quiet" onClick={() => startLinked(it.taskId!)}>▶ Start</button>}
            {t && <button className="btn quiet" onClick={() => openInBoard(it.taskId!)}>Open in board</button>}
            <button className="btn quiet danger" onClick={() => setIssueState(it.key, 'inbox', 'unlinked — back in the inbox')}>Unlink</button>
          </> : <>
            <span className="dimnote">{it.state === 'ignored' ? 'Ignored — hidden from the inbox' : 'Archived — no longer tracked'}</span>
            <span style={{ flex: 1 }} />
            <button className="btn quiet" onClick={() => setIssueState(it.key, 'inbox', 'restored to inbox')}><span style={{ color: 'var(--acc)' }}>Restore</span></button>
          </>}
        </div>
      </div>
    </>
  )
}
