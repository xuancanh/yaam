import { useCallback, useEffect, useRef, useState } from 'react'
import { useYaam, useYaamState } from '@yaam/addon-sdk/react'

// ---------------- model ----------------
interface WFNode {
  id: string; title: string; description?: string; criteria?: string[]
  cwd?: string; maxVisits?: number; isolate?: boolean
  onDone?: string | null; onFail?: string | null; x: number; y: number
}
interface WF {
  id: string; name: string; desc?: string; cron?: string; cronOn?: boolean
  enabled?: boolean; start?: string | null; nodes: WFNode[]; runSeq?: number
}
interface RunStep { nodeId: string; title: string; taskId: string | null; outcome: string; at: number }
interface Run {
  id: string; num?: number; wfId: string; wfName: string; startedAt: number; finishedAt?: number
  status: string; trigger: string; current?: string | null; taskId: string | null
  visits: Record<string, number>; path: RunStep[]
}
type Tab = 'editor' | 'history' | 'settings'

const NW = 196, NH = 64
const STC: Record<string, [string, string]> = { done: ['#3DDC97', 'Done'], running: ['#F5C451', 'Running'], failed: ['#FF5C5C', 'Failed'], idle: ['#6B7280', 'Idle'], skipped: ['#3a4150', 'Skipped'] }
const RSC: Record<string, [string, string]> = { running: ['#F5C451', 'Running'], done: ['#3DDC97', 'Success'], failed: ['#FF5C5C', 'Failed'] }
const PRESETS: [string, string][] = [['', 'None'], ['0 * * * *', 'Hourly'], ['0 6 * * *', 'Daily 06:00'], ['0 6 * * 1', 'Mon 06:00'], ['custom', 'Custom…']]

const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago' }
const enabled = (w: WF) => w.enabled !== false
const runLabel = (r: Run) => r.num ? '#' + r.num : r.id.slice(-4)
const nid = () => 'n' + Date.now().toString(36)
const wid = () => 'w' + Date.now().toString(36)

function edgePath(s: { x: number; y: number }, t: { x: number; y: number }) {
  const x1 = s.x + NW, y1 = s.y + NH / 2, x2 = t.x, y2 = t.y + NH / 2
  if (x2 >= x1 - 20) {
    const dx = Math.max(46, Math.abs(x2 - x1) / 2)
    return { d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 11 }
  }
  const dip = Math.max(y1, y2) + 64
  return { d: `M${x1},${y1} C${x1 + 60},${dip} ${x2 - 60},${dip} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: dip - 14 }
}

// ================= App =================
export function App() {
  const { api } = useYaam()
  const snap = useYaamState()

  const [workflows, setWorkflows] = useState<WF[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [banner, setBannerState] = useState<string | null>(null)

  const [page, setPage] = useState<'list' | 'detail'>('list')
  const [tab, setTab] = useState<Tab>('editor')
  const [wfId, setWfId] = useState<string | null>(null)
  const [nodeId, setNodeId] = useState<string | null>(null)
  const [runSel, setRunSel] = useState<string>('live')
  const [cardMenu, setCardMenu] = useState<string | null>(null)
  const [wfMenu, setWfMenu] = useState(false)
  const [linking, setLinking] = useState<{ src: string; kind: 'done' | 'fail' } | null>(null)
  const [delArmed, setDelArmed] = useState<string | null>(null)
  const delTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const bannerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showBanner = useCallback((msg: string) => {
    setBannerState(/permission "/.test(msg) ? msg + ' — grant it in the Addons view, then retry.' : msg)
    clearTimeout(bannerTimer.current)
    bannerTimer.current = setTimeout(() => setBannerState(null), 6000)
  }, [])

  const persist = useCallback(async (next: WF[]) => {
    setWorkflows(next)
    try { await api.storage.set('workflows', next) } catch (e) { showBanner((e as Error).message) }
  }, [api, showBanner])
  const persistRuns = useCallback(async (next: Run[]) => {
    setRuns(next)
    try { await api.storage.set('runs', next) } catch { /* storage denied */ }
  }, [api])

  const wf = workflows.find(w => w.id === wfId) || null
  const updateWf = useCallback((id: string, recipe: (w: WF) => void) => {
    setWorkflows(prev => {
      const next = prev.map(w => { if (w.id !== id) return w; const c = structuredClone(w) as WF; recipe(c); return c })
      void api.storage.set('workflows', next).catch((e: Error) => showBanner(e.message))
      return next
    })
  }, [api, showBanner])

  // ---- initial load ----
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const w = ((await api.storage.get('workflows')) as WF[]) || []
        const r = ((await api.storage.get('runs')) as Run[]) || []
        if (!alive) return
        setWorkflows(w); setRuns(r)
        setWfId(id => id || (w.length ? w[0].id : null))
      } catch (e) { if (alive) showBanner((e as Error).message) }
    })()
    return () => { alive = false }
  }, [api, showBanner])

  // ---- on each state push (~3s): re-pull runs (the hooks advance them) ----
  useEffect(() => {
    let alive = true
    api.storage.get('runs').then(r => { if (alive && r) setRuns(r as Run[]) }).catch(() => {})
    return () => { alive = false }
  }, [snap, api])

  // ---- global keys + click-away ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { setLinking(null); setWfMenu(false); setCardMenu(null) }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && nodeId && tab === 'editor' && !/INPUT|TEXTAREA/.test((document.activeElement as HTMLElement)?.tagName || '')) deleteNode()
    }
    const onClick = () => { setWfMenu(false); setCardMenu(null) }
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick) }
  }) // deliberately re-bound each render so handlers see fresh state

  // ---------------- status maps ----------------
  const liveStatus = useCallback((): Record<string, string> => {
    const r = runs.find(x => x.wfId === wfId)
    const map: Record<string, string> = {}
    if (r && (r.status === 'running' || Date.now() - (r.finishedAt || r.startedAt) < 120000)) {
      for (const p of r.path || []) map[p.nodeId] = p.outcome
      if (r.status === 'running' && r.current) map[r.current] = 'running'
    }
    return map
  }, [runs, wfId])
  const statusMap = (): { map: Record<string, string>; replay: Run | null } => {
    if (runSel === 'live') return { map: liveStatus(), replay: null }
    const r = runs.find(x => x.id === runSel)
    if (!r) return { map: liveStatus(), replay: null }
    const map: Record<string, string> = {}
    for (const p of r.path || []) map[p.nodeId] = p.outcome
    if (r.status === 'running' && r.current) map[r.current] = 'running'
    return { map, replay: r }
  }

  // ---------------- node actions ----------------
  const selectNode = (id: string) => setNodeId(id)
  const moveNode = (id: string, x: number, y: number) => updateWf(wfId!, w => { const n = w.nodes.find(n => n.id === id); if (n) { n.x = x; n.y = y } })
  const setTransition = (srcId: string, kind: 'done' | 'fail', targetId: string) =>
    updateWf(wfId!, w => { const s = w.nodes.find(n => n.id === srcId); if (s) s[kind === 'done' ? 'onDone' : 'onFail'] = targetId })
  const removeEdge = (srcId: string, field: 'onDone' | 'onFail') =>
    updateWf(wfId!, w => { const s = w.nodes.find(n => n.id === srcId); if (s) s[field] = null })

  function deleteNode() {
    if (!wf || !nodeId) return
    const del = nodeId
    updateWf(wf.id, w => {
      w.nodes = w.nodes.filter(x => x.id !== del)
      for (const n of w.nodes) { if (n.onDone === del) n.onDone = null; if (n.onFail === del) n.onFail = null }
      if (w.start === del) w.start = w.nodes[0]?.id || null
    })
    setNodeId(null); setLinking(null)
  }
  function saveNode(patch: Partial<WFNode>) { if (wf && nodeId) updateWf(wf.id, w => { const n = w.nodes.find(x => x.id === nodeId); if (n) Object.assign(n, patch) }) }
  function setStart() { if (wf && nodeId) updateWf(wf.id, w => { w.start = nodeId }) }
  function addStepAfter() {
    if (!wf || !nodeId) return
    const id = nid()
    updateWf(wf.id, w => {
      const src = w.nodes.find(n => n.id === nodeId); if (!src) return
      w.nodes.push({ id, title: 'step ' + (w.nodes.length + 1), description: '', criteria: [], onDone: null, onFail: null, x: src.x + NW + 60, y: src.y })
      if (!src.onDone) src.onDone = id
    })
    setNodeId(id)
  }

  // ---------------- workflow CRUD ----------------
  const openWorkflow = (id: string) => { setWfId(id); setPage('detail'); setTab('editor'); setRunSel('live'); setNodeId(null); setCardMenu(null); setLinking(null) }
  function newWorkflow() {
    const id = wid()
    const first = nid()
    const w: WF = { id, name: 'workflow ' + (workflows.length + 1), desc: '', cron: '', cronOn: false, enabled: true, start: first, nodes: [{ id: first, title: 'step 1', description: '', criteria: [], onDone: null, onFail: null, x: 60, y: 60 }], runSeq: 0 }
    void persist([...workflows, w])
    setNodeId(first)
    openWorkflow(id)
  }
  function seedDemo() {
    const id = wid()
    const mk = (nId: string, title: string, description: string, x: number, y: number, criteria: string[] = []): WFNode => ({ id: nId, title, description, criteria, x, y, onDone: null, onFail: null })
    const plan = mk('plan', 'plan', 'Study the codebase and write IMPLEMENTATION_PLAN.md for the change described in this workflow run.', 40, 130, ['plan file exists with concrete steps'])
    const impl = mk('impl', 'implement', 'Implement the change following IMPLEMENTATION_PLAN.md.', 300, 130, ['typecheck passes', 'lint passes'])
    const test = mk('test', 'verify', 'Run the full test suite and typecheck; fix nothing — only verify and report.', 560, 130, ['test suite green'])
    const fix = mk('fix', 'fix failures', 'The verify step failed. Diagnose the failing tests/typecheck and repair the implementation.', 560, 320, ['previously failing checks now pass'])
    const rel = mk('rel', 'release notes', 'Summarize what shipped into RELEASE_NOTES.md.', 820, 130, [])
    plan.onDone = 'impl'; impl.onDone = 'test'; test.onDone = 'rel'; test.onFail = 'fix'; fix.onDone = 'test'; fix.maxVisits = 2
    const w: WF = { id, name: 'ship a change', desc: 'Plan → implement → verify, with a remediation loop on failures, then release notes.', cron: '', cronOn: false, enabled: true, start: 'plan', nodes: [plan, impl, test, fix, rel], runSeq: 0 }
    void persist([...workflows, w])
    openWorkflow(id)
  }
  function duplicateWorkflow(id: string) {
    const src = workflows.find(x => x.id === id); if (!src) return
    const copy: WF = { ...structuredClone(src), id: wid(), name: src.name + ' (copy)', cronOn: false, enabled: false, runSeq: 0 }
    setCardMenu(null)
    void persist([...workflows, copy])
    api.flash('workflow duplicated — paused until you enable it').catch(() => {})
  }
  function armDelete(id: string) {
    setDelArmed(id)
    clearTimeout(delTimer.current)
    delTimer.current = setTimeout(() => setDelArmed(null), 2600)
  }
  async function deleteWorkflow(id: string) {
    if (delArmed !== id) { armDelete(id); return }
    const w = workflows.find(x => x.id === id)
    if (w && w.cronOn) await api.schedules.remove('wf-' + w.id).catch(() => {})
    const nextRuns = runs.filter(r => r.wfId !== id)
    await persistRuns(nextRuns)
    const nextW = workflows.filter(x => x.id !== id)
    setDelArmed(null); setCardMenu(null)
    if (wfId === id) { setWfId(nextW.length ? nextW[0].id : null); if (page === 'detail') setPage('list') }
    await persist(nextW)
  }
  const toggleWfEnabled = (id: string) => updateWf(id, w => { w.enabled = !enabled(w) })

  // ---------------- runs ----------------
  async function runNow() {
    if (!wf || !wf.nodes.length) return
    try {
      const allRuns = ((await api.storage.get('runs')) as Run[]) || []
      if (allRuns.some(r => r.wfId === wf.id && r.status === 'running')) { showBanner('a run of this machine is already going'); return }
      const seq = (wf.runSeq || 0) + 1
      updateWf(wf.id, w => { w.runSeq = seq })
      const start = wf.nodes.find(n => n.id === wf.start) || wf.nodes[0]
      const run: Run = { id: 'run' + Date.now().toString(36), num: seq, wfId: wf.id, wfName: wf.name, startedAt: Date.now(), status: 'running', trigger: 'manual', current: start.id, taskId: null, visits: {}, path: [] }
      const taskId = await api.tasks.add(start.title, 'backlog', {
        description: ['[workflow "' + wf.name + '" · run ' + run.id + ' · step ' + start.id + ']', start.description || ''].filter(Boolean).join('\n\n'),
        criteria: start.criteria || [], cwd: start.cwd || undefined, isolate: start.isolate === true ? true : undefined,
      })
      run.taskId = taskId; run.visits[start.id] = 1
      run.path.push({ nodeId: start.id, title: start.title, taskId, outcome: 'running', at: Date.now() })
      await persistRuns([run, ...allRuns].slice(0, 30))
      await api.tasks.start(taskId)
      await api.flash('machine entered "' + start.title + '"')
      setRunSel('live')
    } catch (e) { showBanner((e as Error).message) }
  }

  // ---------------- render ----------------
  return (
    <>
      {banner && <div id="banner">{banner}</div>}
      {page === 'list'
        ? <ListPage {...{ workflows, runs, cardMenu, setCardMenu, delArmed, openWorkflow, newWorkflow, seedDemo, duplicateWorkflow, deleteWorkflow, toggleWfEnabled }} />
        : wf && <DetailPage {...{ wf, workflows, runs, tab, setTab, nodeId, runSel, setRunSel, wfMenu, setWfMenu, linking, setLinking, delArmed, statusMap: statusMap(), backToList: () => { setPage('list'); setWfMenu(false); setLinking(null) }, pickWf: (id: string) => { setWfId(id); setNodeId(null); setRunSel('live'); setWfMenu(false); setLinking(null) }, runNow, selectNode, setNodeId, moveNode, setTransition, removeEdge, deleteNode, saveNode, setStart, addStepAfter, updateWf, api, showBanner, removeWorkflow: () => deleteWorkflow(wf.id) }} />}
    </>
  )
}

// ================= List page =================
interface ListProps {
  workflows: WF[]; runs: Run[]; cardMenu: string | null; setCardMenu: (v: string | null) => void; delArmed: string | null
  openWorkflow: (id: string) => void; newWorkflow: () => void; seedDemo: () => void
  duplicateWorkflow: (id: string) => void; deleteWorkflow: (id: string) => void; toggleWfEnabled: (id: string) => void
}
function ListPage(p: ListProps) {
  const empty = !p.workflows.length
  const running = (w: WF) => p.runs.some(r => r.wfId === w.id && r.status === 'running')
  const stats: [number, string, string][] = [
    [p.workflows.length, 'Workflows', 'var(--text)'],
    [p.workflows.filter(enabled).length, 'Active', 'var(--green)'],
    [p.runs.length, 'Recent runs', 'var(--text)'],
    [p.workflows.filter(running).length, 'Running now', 'var(--acc)'],
  ]
  return (
    <div id="pgList">
      <div className="topbar">
        <span style={{ fontWeight: 600, fontSize: 14 }}>Workflows</span>
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>state machines that chain one-shot agents over board tasks</span>
        <span style={{ flex: 1 }} />
        <button className="btn accent" onClick={p.newWorkflow}>＋ New workflow</button>
      </div>
      {empty
        ? <div id="onboard">
          <div className="card">
            <h3>⛓ Workflows are state machines</h3>
            <p>Each step is a board-task spec. When its task finishes, the machine takes the <b style={{ color: 'var(--green)' }}>on&nbsp;done</b> or <b style={{ color: 'var(--red)' }}>on&nbsp;fail</b> transition — branch into remediation steps, loop back for visit-capped retries, and halt wherever you choose. Trigger runs by hand or on a cron.</p>
            <button className="btn accent" onClick={p.seedDemo}>Create an example machine</button>
            <button className="btn" onClick={p.newWorkflow}>Start empty</button>
          </div>
        </div>
        : <div id="listBody">
          <div id="stats">{stats.map((s, i) => <div key={i} className="st"><div className="v" style={{ color: s[2] }}>{s[0]}</div><div className="l">{s[1]}</div></div>)}</div>
          <div id="grid">
            {p.workflows.map(w => {
              const mine = p.runs.filter(r => r.wfId === w.id)
              const done = mine.filter(r => r.status === 'done').length
              const isRun = running(w)
              const live: [string, string] = !enabled(w) ? ['var(--gray)', 'Paused'] : isRun ? ['var(--acc)', 'Running'] : ['var(--green)', 'Active']
              const last = mine[0]
              return (
                <div key={w.id} className="wfcard" onClick={() => p.openWorkflow(w.id)}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                    <span className="ic" style={{ background: w.cronOn ? 'rgba(127,209,255,.15)' : 'rgba(61,220,151,.15)' }}>{w.cronOn ? '🕒' : '▶'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}><div className="nm">{w.name}</div><div className="trg">{w.cronOn ? 'On cron ' + w.cron : 'Manual only'}</div></div>
                  </div>
                  <div className="ds">{w.desc || 'No description yet — add one in the workflow’s Settings tab.'}</div>
                  <div className="ft">
                    <span className="chip" style={{ color: live[0], background: `color-mix(in srgb,${live[0]} 14%,transparent)` }}><span className="d" style={{ background: live[0] }} />{live[1]}</span>
                    <span className="k">{w.nodes.length} steps</span>
                    <span className="k">{mine.length ? Math.round(done / mine.length * 100) + '% pass' : '—'}</span>
                    <span style={{ flex: 1 }} />
                    <span className="k">{last ? (last.status === 'running' ? 'running now' : 'last run ' + ago(last.startedAt)) : 'no runs yet'}</span>
                  </div>
                  <div style={{ position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', gap: 6 }} onClick={ev => ev.stopPropagation()}>
                    <button className={'sw' + (enabled(w) ? ' on' : '')} title="Enable / pause the cron trigger" onClick={() => p.toggleWfEnabled(w.id)}><i /></button>
                    <button className="dots" onClick={ev => { ev.stopPropagation(); p.setCardMenu(p.cardMenu === w.id ? null : w.id) }}>⋮</button>
                  </div>
                  <div className={'menu' + (p.cardMenu === w.id ? ' open' : '')} onClick={ev => ev.stopPropagation()}>
                    <button onClick={() => p.openWorkflow(w.id)}>Open</button>
                    <button onClick={() => p.duplicateWorkflow(w.id)}>Duplicate</button>
                    <button className="red" onClick={() => p.deleteWorkflow(w.id)}>{p.delArmed === w.id ? 'Sure? click again' : 'Delete'}</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>}
    </div>
  )
}

// ================= Detail page =================
interface DetailProps {
  wf: WF; workflows: WF[]; runs: Run[]; tab: Tab; setTab: (t: Tab) => void; nodeId: string | null
  runSel: string; setRunSel: (v: string) => void; wfMenu: boolean; setWfMenu: (v: boolean) => void
  linking: { src: string; kind: 'done' | 'fail' } | null; setLinking: (v: { src: string; kind: 'done' | 'fail' } | null) => void
  delArmed: string | null; statusMap: { map: Record<string, string>; replay: Run | null }
  backToList: () => void; pickWf: (id: string) => void; runNow: () => void
  selectNode: (id: string) => void; setNodeId: (id: string | null) => void
  moveNode: (id: string, x: number, y: number) => void; setTransition: (s: string, k: 'done' | 'fail', t: string) => void
  removeEdge: (s: string, f: 'onDone' | 'onFail') => void; deleteNode: () => void; saveNode: (patch: Partial<WFNode>) => void
  setStart: () => void; addStepAfter: () => void; updateWf: (id: string, recipe: (w: WF) => void) => void
  api: ReturnType<typeof useYaam>['api']; showBanner: (m: string) => void; removeWorkflow: () => void
}
function DetailPage(p: DetailProps) {
  const { wf, statusMap, tab, linking } = p
  const isCanvas = tab !== 'settings'
  const running = p.runs.some(r => r.wfId === wf.id && r.status === 'running')
  const hint = linking
    ? <>◈ click the <b className={linking.kind === 'done' ? 'g' : 'r'}>on {linking.kind}</b> target — <kbd>Esc</kbd> cancels</>
    : <>one active step per run · select a step, then <b className="g">on done →</b> / <b className="r">on fail →</b> and click the target · loops allowed (visit-capped) · no transition = the machine halts there · click an edge to remove it · <kbd>⌫</kbd> deletes · <kbd>Esc</kbd> cancels linking</>
  return (
    <div id="pgDetail">
      <div className="topbar">
        <button className="backbtn" title="All workflows" onClick={p.backToList}>‹</button>
        <div id="wfPick" onClick={ev => { ev.stopPropagation(); p.setWfMenu(!p.wfMenu) }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5C451" strokeWidth="1.7" strokeLinecap="round"><circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M7.5 6H15a3 3 0 013 3v6.5" /></svg>
          <div><div className="nm">{wf.name}</div><div className="tg">{wf.cronOn ? 'On cron ' + wf.cron : 'Manual only'}</div></div>
          <span style={{ color: 'var(--dim)', fontSize: 11 }}>▾</span>
          <div id="wfMenu" className={p.wfMenu ? 'open' : ''} onClick={ev => ev.stopPropagation()}>
            {p.workflows.map(x => {
              const isRun = p.runs.some(r => r.wfId === x.id && r.status === 'running')
              return (
                <button key={x.id} onClick={() => p.pickWf(x.id)}>
                  <span className="d" style={{ background: isRun ? 'var(--acc)' : enabled(x) ? 'var(--green)' : 'var(--gray)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 600 }}>{x.name}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--mut)', fontFamily: "'JetBrains Mono',monospace", marginTop: 1 }}>{x.cronOn ? 'On cron ' + x.cron : 'Manual only'}</div></div>
                </button>
              )
            })}
          </div>
        </div>
        {statusMap.replay && <div id="replayPill"><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--acc)' }} /><span>{'Replaying run ' + runLabel(statusMap.replay) + ' · ' + ago(statusMap.replay.startedAt)}</span><button onClick={() => p.setRunSel('live')}>Back to live</button></div>}
        <span style={{ flex: 1 }} />
        <div className="seg">
          {(['editor', 'history', 'settings'] as Tab[]).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => { p.setTab(t); p.setNodeId(null); if (t !== 'history') p.setRunSel('live'); p.setLinking(null) }}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <button className="btn accent" disabled={running || !wf.nodes.length} onClick={p.runNow}>{running ? '● Running…' : '▶ Run'}</button>
      </div>

      {isCanvas && <div id="hint">{hint}</div>}

      {isCanvas
        ? <div id="detailBody">
          <Canvas {...p} />
          {tab === 'history' && <Rail {...p} />}
        </div>
        : <SettingsTab {...p} />}
    </div>
  )
}

// ================= Canvas =================
function Canvas(p: DetailProps) {
  const { wf, statusMap, tab, nodeId, linking } = p
  const { map, replay } = statusMap
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dragPos, setDragPos] = useState<{ id: string; x: number; y: number } | null>(null)
  const [ghost, setGhost] = useState<{ d: string; stroke: string } | null>(null)
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  const moved = useRef(false)

  const byId: Record<string, WFNode> = {}
  for (const n of wf.nodes) byId[n.id] = n
  const posOf = (n: WFNode) => (dragPos && dragPos.id === n.id) ? dragPos : n
  const start = wf.start && byId[wf.start] ? wf.start : (wf.nodes[0] && wf.nodes[0].id)
  const maxX = Math.max(900, ...wf.nodes.map(n => posOf(n).x + NW + 280))
  const maxY = Math.max(560, ...wf.nodes.map(n => posOf(n).y + NH + 150))

  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      if (linking) {
        const s = byId[linking.src]
        const wrap = wrapRef.current
        if (s && wrap) {
          const r = wrap.getBoundingClientRect()
          const mx = ev.clientX - r.left + wrap.scrollLeft
          const my = ev.clientY - r.top + wrap.scrollTop
          setGhost({ d: `M${posOf(s).x + NW},${posOf(s).y + NH / 2} L${mx},${my}`, stroke: linking.kind === 'done' ? '#3DDC97' : '#FF5C5C' })
        }
      }
      const d = drag.current
      if (!d) return
      d.moved = true; moved.current = true
      setDragPos({ id: d.id, x: Math.max(0, Math.round((ev.clientX - d.dx) / 10) * 10), y: Math.max(0, Math.round((ev.clientY - d.dy) / 10) * 10) })
    }
    const onUp = () => {
      const d = drag.current
      if (d && d.moved && dragPos) p.moveNode(d.id, dragPos.x, dragPos.y)
      drag.current = null; setDragPos(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }) // re-bound each render for fresh linking/dragPos

  useEffect(() => { if (!linking) setGhost(null) }, [linking])

  const onNodeDown = (ev: React.PointerEvent, n: WFNode) => {
    if (linking || tab !== 'editor') return
    drag.current = { id: n.id, dx: ev.clientX - posOf(n).x, dy: ev.clientY - posOf(n).y, moved: false }
    moved.current = false
  }
  const onNodeClick = (ev: React.MouseEvent, n: WFNode) => {
    ev.stopPropagation()
    if (moved.current) { moved.current = false; return }
    if (linking && linking.src !== n.id) { p.setTransition(linking.src, linking.kind, n.id); p.setLinking(null); return }
    p.selectNode(n.id)
  }
  const onCanvasClick = (ev: React.MouseEvent) => {
    if (ev.target === wrapRef.current || (ev.target as HTMLElement).id === 'canvas') { p.setNodeId(null); p.setLinking(null) }
  }

  return (
    <div id="canvasWrap" ref={wrapRef} onClick={onCanvasClick}>
      <div id="canvas" style={{ width: maxX, height: maxY }}>
        <svg id="edgeSvg" width={maxX} height={maxY}>
          <defs>
            <marker id="arrG" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#3DDC97" /></marker>
            <marker id="arrR" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#FF5C5C" /></marker>
            <marker id="arrDim" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#2a2f39" /></marker>
          </defs>
          <g>
            {wf.nodes.flatMap(n => ([['onDone', 'done'], ['onFail', 'fail']] as ['onDone' | 'onFail', 'done' | 'fail'][]).flatMap(([field, kind]) => {
              const tid = n[field]; const t = tid ? byId[tid] : null
              if (!t) return []
              const { d } = edgePath(posOf(n), posOf(t))
              const active = map[n.id] && map[n.id] !== 'skipped' && map[t.id]
              const col = kind === 'done' ? '#3DDC97' : '#FF5C5C'
              return [(
                <path key={n.id + field} className="e" d={d} fill="none"
                  stroke={active || !replay ? col : '#2a2f39'} strokeOpacity={active || !replay ? (kind === 'done' ? 0.65 : 0.6) : 1}
                  strokeWidth={active ? 2.2 : 1.6} strokeDasharray={kind === 'fail' ? '6 4' : undefined}
                  markerEnd={active || !replay ? (kind === 'done' ? 'url(#arrG)' : 'url(#arrR)') : 'url(#arrDim)'}
                  onClick={ev => { ev.stopPropagation(); if (tab === 'editor') p.removeEdge(n.id, field) }}>
                  <title>{`${n.title} — on ${kind} → ${t.title} (click to remove)`}</title>
                </path>
              )]
            }))}
          </g>
          {ghost && <path d={ghost.d} fill="none" strokeWidth="1.4" strokeDasharray="5 4" stroke={ghost.stroke} />}
        </svg>
        {wf.nodes.flatMap(n => ([['onDone', 'done'], ['onFail', 'fail']] as ['onDone' | 'onFail', 'done' | 'fail'][]).flatMap(([field, kind]) => {
          const tid = n[field]; const t = tid ? byId[tid] : null
          if (!t) return []
          const { lx, ly } = edgePath(posOf(n), posOf(t))
          const col = kind === 'done' ? '#3DDC97' : '#FF5C5C'
          return [<span key={n.id + field + 'l'} className="elbl" style={{ left: lx, top: ly, color: col, borderColor: `color-mix(in srgb,${col} 40%,transparent)`, background: '#12151C' }}>on {kind}</span>]
        }))}
        {wf.nodes.map(n => {
          const pos = posOf(n)
          const stk = map[n.id] || 'idle'
          const st = STC[stk] || STC.idle
          const dimmed = replay && (stk === 'idle' || stk === 'skipped')
          const bits: string[] = []
          if ((n.criteria || []).length) bits.push(n.criteria!.length + ' crit')
          if (n.isolate) bits.push('⑂')
          if (!n.onDone) bits.push('halts on ✓')
          return (
            <div key={n.id} className={'node' + (n.id === linking?.src ? ' linksrc' : '')}
              style={{
                left: pos.x, top: pos.y,
                borderColor: n.id === nodeId ? 'var(--acc)' : st[0],
                boxShadow: n.id === nodeId ? '0 0 0 2px rgba(245,196,81,.35)' : stk === 'running' ? `0 0 0 3px color-mix(in srgb,${st[0]} 18%,transparent)` : 'none',
                opacity: dimmed ? 0.5 : 1,
              }}
              onPointerDown={ev => onNodeDown(ev, n)} onClick={ev => onNodeClick(ev, n)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}><div className="t">{n.title}</div><div className="s">{bits.join(' · ') || 'new step'}</div></div>
                {n.id === start ? <span className="startb">▶ START</span> : <span className="tag">STEP</span>}
              </div>
              <div className="st" style={{ color: st[0] }}><span className="d" style={{ background: st[0], animation: stk === 'running' ? 'cpulse 1.3s ease-in-out infinite' : undefined }} />{st[1]}</div>
            </div>
          )
        })}
      </div>
      {tab === 'editor' && nodeId && byId[nodeId] && <Inspector key={nodeId} node={byId[nodeId]} status={STC[map[nodeId] || 'idle'] || STC.idle} nameOf={id => { const t = id ? byId[id] : null; return t ? '→ ' + t.title : null }} {...p} />}
    </div>
  )
}

// ================= Inspector =================
function Inspector(p: DetailProps & { node: WFNode; status: [string, string]; nameOf: (id: string | null | undefined) => string | null }) {
  const { node, status } = p
  const [title, setTitle] = useState(node.title)
  const [desc, setDesc] = useState(node.description || '')
  const [crit, setCrit] = useState((node.criteria || []).join('\n'))
  const [cwd, setCwd] = useState(node.cwd || '')
  const [max, setMax] = useState(node.maxVisits ? String(node.maxVisits) : '')
  const [iso, setIso] = useState(!!node.isolate)
  const save = () => p.saveNode({
    title: title.trim() || node.title, description: desc,
    criteria: crit.split('\n').map(x => x.trim()).filter(Boolean),
    cwd: cwd.trim(), maxVisits: Math.max(0, Math.min(9, parseInt(max, 10) || 0)) || undefined, isolate: iso,
  })
  return (
    <div id="inspector">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="tag" style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.5px', color: '#7FD1FF' }}>STEP</span>
        <span className="chip" style={{ color: status[0], background: `color-mix(in srgb,${status[0]} 14%,transparent)` }}>{status[1]}</span>
        <span style={{ flex: 1 }} />
        <button className="btn quiet" style={{ padding: '2px 7px' }} onClick={() => p.setNodeId(null)}>✕</button>
      </div>
      <label>Step title</label><input value={title} onChange={e => setTitle(e.target.value)} />
      <label>What the agent should do</label><textarea rows={4} value={desc} onChange={e => setDesc(e.target.value)} placeholder="clear instructions for a one-shot agent…" />
      <label>Acceptance criteria — one per line</label><textarea rows={3} value={crit} onChange={e => setCrit(e.target.value)} placeholder={'tests pass\ndocs updated'} />
      <label>Working directory</label><input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="(workspace default)" />
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><label>Max visits / run</label><input type="number" min={1} max={9} value={max} onChange={e => setMax(e.target.value)} placeholder="3" /></div>
        <div style={{ flex: 1.4, display: 'flex', alignItems: 'flex-end' }}><div className="chk"><input type="checkbox" checked={iso} onChange={e => setIso(e.target.checked)} /><span>worktree ⑂</span></div></div>
      </div>
      <label style={{ marginTop: 3 }}>Transitions</label>
      <div className="trow"><b style={{ color: 'var(--green)' }}>on done</b><span style={{ flex: 1 }}>{p.nameOf(node.onDone) || '— halt (success)'}</span><button className="linkbtn" style={{ color: 'var(--green)', borderColor: 'rgba(61,220,151,.4)' }} onClick={() => p.setLinking({ src: node.id, kind: 'done' })}>set →</button><button className="btn quiet" style={{ padding: '3px 7px' }} onClick={() => p.removeEdge(node.id, 'onDone')}>✕</button></div>
      <div className="trow"><b style={{ color: 'var(--red)' }}>on fail</b><span style={{ flex: 1 }}>{p.nameOf(node.onFail) || '— halt (failure)'}</span><button className="linkbtn" style={{ color: 'var(--red)', borderColor: 'rgba(255,92,92,.4)' }} onClick={() => p.setLinking({ src: node.id, kind: 'fail' })}>set →</button><button className="btn quiet" style={{ padding: '3px 7px' }} onClick={() => p.removeEdge(node.id, 'onFail')}>✕</button></div>
      <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
        <button className="btn accent" style={{ flex: 1, justifyContent: 'center' }} onClick={save}>Save</button>
        <button className="btn" title="the machine enters here" onClick={p.setStart}>▶ start</button>
        <button className="btn" title="add a step after this one (linked on done)" onClick={p.addStepAfter}>＋ after</button>
        <button className="btn danger" onClick={p.deleteNode}>✕</button>
      </div>
    </div>
  )
}

// ================= Run history rail =================
function Rail(p: DetailProps) {
  const mine = p.runs.filter(r => r.wfId === p.wf.id)
  return (
    <div id="rail">
      <div className="hd">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8B93A1" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2.5 6 5-12 2.5 6h4" /></svg>
        <b>Run history</b><span>click to replay</span>
      </div>
      <div id="runList">
        <button className={'runcard' + (p.runSel === 'live' ? ' on' : '')} onClick={() => p.setRunSel('live')}>
          <span className="d" style={{ background: 'var(--acc)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="n">LIVE</span><span className="sc" style={{ color: 'var(--acc)', background: 'var(--accsoft)' }}>Live state</span></div>
            <div className="tr">Current machine state</div><div className="wh">now</div>
          </div>
        </button>
        {mine.slice(0, 15).map(r => {
          const st = RSC[r.status] || RSC.done
          const dur = r.finishedAt ? Math.max(1, Math.round((r.finishedAt - r.startedAt) / 60000)) + ' min' : 'running'
          const steps = (r.path || []).length
          return (
            <button key={r.id} className={'runcard' + (p.runSel === r.id ? ' on' : '')} onClick={() => p.setRunSel(r.id)}>
              <span className="d" style={{ background: st[0] }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="n">{runLabel(r)}</span><span className="sc" style={{ color: st[0], background: `color-mix(in srgb,${st[0]} 14%,transparent)` }}>{st[1]}</span></div>
                <div className="tr">{(r.trigger === 'cron' ? 'Cron trigger' : 'Manual run') + ' · ' + steps + ' step(s)'}</div>
                <div className="wh">{ago(r.startedAt) + ' · ' + dur}</div>
              </div>
            </button>
          )
        })}
        {!mine.length && <div className="empty">no runs yet — hit ▶ Run or arm the cron trigger in Settings</div>}
      </div>
    </div>
  )
}

// ================= Settings tab =================
function SettingsTab(p: DetailProps) {
  const { wf } = p
  const [custom, setCustom] = useState(false)
  const [desc, setDesc] = useState(wf.desc || '')
  useEffect(() => { setDesc(wf.desc || '') }, [wf.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const preset = PRESETS.some(pp => pp[0] === wf.cron) ? wf.cron : 'custom'
  const showCustom = custom || preset === 'custom'

  async function toggleCron() {
    try {
      if (wf.cronOn) { await p.api.schedules.remove('wf-' + wf.id); p.updateWf(wf.id, w => { w.cronOn = false }) }
      else {
        const cron = (wf.cron || '').trim()
        if (cron.split(/\s+/).length !== 5) { p.showBanner('pick a preset or give a 5-field cron, e.g. 0 6 * * *'); return }
        const res = await p.api.schedules.add({ name: 'wf-' + wf.id, schedule: cron })
        if (typeof res === 'string' && res.indexOf('created') === -1) { p.showBanner(res); return }
        p.updateWf(wf.id, w => { w.cronOn = true })
      }
    } catch (e) { p.showBanner((e as Error).message) }
  }
  const pickPreset = (val: string) => {
    if (val === 'custom') { setCustom(true); return }
    setCustom(false)
    if (!val && wf.cronOn) { void toggleCron() } else p.updateWf(wf.id, w => { w.cron = val })
  }

  return (
    <div id="pgSettingsTab">
      <div className="wrap">
        <div className="scard">
          <div className="srow">
            <div className="g"><div className="t">Enable this workflow</div><div className="d">When paused, the cron trigger is ignored and no scheduled runs start. You can still hit ▶ Run yourself.</div></div>
            <button className={'sw' + (enabled(wf) ? ' on' : '')} onClick={() => p.updateWf(wf.id, w => { w.enabled = !enabled(w) })}><i /></button>
          </div>
        </div>
        <div>
          <div className="shead">Trigger</div>
          <div className="scard">
            <div className="srow">
              <div className="g"><div className="t">Cron trigger</div><div className="d">Start a run automatically on a schedule. One machine per workflow — a firing is skipped while a run is still going.</div></div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                {PRESETS.map(pp => <button key={pp[0]} className={'opt' + ((showCustom ? 'custom' : preset) === pp[0] ? ' on' : '')} onClick={() => pickPreset(pp[0])}>{pp[1]}</button>)}
              </div>
            </div>
            {showCustom && (
              <div className="srow">
                <div className="g"><div className="t">Custom expression</div><div className="d">Five fields: minute hour day month weekday.</div></div>
                <input className="cronin" defaultValue={preset === 'custom' ? (wf.cron || '') : ''} placeholder="*/30 * * * *" onChange={e => p.updateWf(wf.id, w => { w.cron = e.target.value.trim() })} />
              </div>
            )}
            <div className="srow">
              <div className="g">
                <div className="t">{wf.cronOn ? '✓ Armed — runs on ' + wf.cron : 'Not armed'}</div>
                <div className="d">{wf.cronOn ? 'The schedule "wf-' + wf.id + '" starts a run at the workflow’s start step.' : (wf.cron ? 'Arm to create the schedule for ' + wf.cron + '.' : 'Pick a preset or a custom expression first.')}</div>
              </div>
              <button className={wf.cronOn ? 'btn' : 'btn accent'} onClick={toggleCron}>{wf.cronOn ? 'Disarm' : 'Arm'}</button>
            </div>
          </div>
        </div>
        <div>
          <div className="shead">Description</div>
          <div className="scard"><div style={{ padding: '12px 15px' }}>
            <textarea className="desc" rows={2} value={desc} onChange={e => setDesc(e.target.value)} onBlur={() => p.updateWf(wf.id, w => { w.desc = desc.trim().slice(0, 240) })} placeholder="What this workflow does — shown on its card in the list." />
          </div></div>
        </div>
        <div>
          <div className="danger-h">DANGER ZONE</div>
          <div className="scard" style={{ borderColor: 'rgba(255,92,92,.25)' }}>
            <div className="srow">
              <div className="g"><div className="t">Delete workflow</div><div className="d">Permanently remove this workflow. Its run history entries are removed too.</div></div>
              <button className="btn danger" onClick={p.removeWorkflow}>{p.delArmed === wf.id ? 'Sure? click again' : 'Delete workflow'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
