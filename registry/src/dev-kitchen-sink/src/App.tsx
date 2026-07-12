import { useEffect, useRef, useState } from 'react'
import { useYaam, useYaamState } from '@yaam/addon-sdk/react'
import { ago as agoFn, banner } from '@yaam/addon-sdk/dom'
import type { AddonSnapshot, SnapshotSession, SnapshotTask, SnapshotCron } from '@yaam/addon-sdk'

const pretty = (v: unknown) => { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }

// two-click confirm — modals are blocked in the sandbox
function ConfirmButton({ onConfirm, children, label = 'sure? click again', ...rest }:
  { onConfirm: () => void; children: React.ReactNode; label?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  return (
    <button {...rest} onClick={ev => {
      ev.stopPropagation()
      if (armed) { clearTimeout(timer.current); setArmed(false); onConfirm() }
      else { setArmed(true); timer.current = setTimeout(() => setArmed(false), 2600) }
    }}>{armed ? label : children}</button>
  )
}

export function App() {
  const { api, guard } = useYaam()
  const snap = useYaamState()

  return (
    <>
      <h1>🧪 Dev Kitchen Sink</h1>
      <div className="sub">every addon capability, live — read alongside <span className="mono">docs/addons.md</span> and <span className="mono">toolkit/README.md</span></div>

      <SectionSnapshot snap={snap} />
      <SectionSessions snap={snap} />
      <SectionTasks snap={snap} />
      <SectionTemplates snap={snap} />
      <SectionSchedules snap={snap} />
      <SectionStorage />
      <SectionHttp />
      <SectionAgent />
      <SectionUiHooks snap={snap} guard={guard} api={api} />
    </>
  )
}

type Snap = AddonSnapshot | null
type Api = ReturnType<typeof useYaam>['api']

const H2 = ({ children, scope }: { children: React.ReactNode; scope: string }) => (
  <h2>{children} <span className="mono" style={{ letterSpacing: 0, textTransform: 'none' }}>{scope}</span></h2>
)

// ---------- 1 · snapshot ----------
function SectionSnapshot({ snap }: { snap: Snap }) {
  return (
    <>
      <H2 scope="state:read">1 · State snapshot</H2>
      <div className="sect-note">pushed into the view every ~3s; also sync via <span className="mono">yaam.onState(cb)</span></div>
      <div className="card">
        {!snap ? <span className="empty">state:read not granted — grant it in the Addons view</span> : <>
          <div className="row">
            <span className="chip"><b>{snap.sessions.length}</b> sessions</span>
            <span className="chip"><b>{snap.tasks.length}</b> tasks</span>
            <span className="chip"><b>{snap.templates.length}</b> templates</span>
            <span className="chip"><b>{snap.machines.length}</b> machines</span>
            <span className="chip"><b>${snap.totals.cost}</b> spent</span>
            <span className="grow" /><span className="meta">workspace: {snap.workspace}</span>
          </div>
          <details style={{ marginTop: 8 }}><summary>raw snapshot JSON</summary><pre>{pretty(snap)}</pre></details>
        </>}
      </div>
    </>
  )
}

// ---------- 2 · sessions ----------
function SectionSessions({ snap }: { snap: Snap }) {
  const { api, guard } = useYaam()
  const [cmd, setCmd] = useState('sleep 30 && echo done')
  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('sink demo')
  const launch = async () => {
    const id = await guard(api.launchSession(cmd, cwd, name))
    if (id) api.flash('launched ' + id).catch(() => {})
  }
  const sessions = (snap ? snap.sessions : []).slice(0, 8)
  return (
    <>
      <H2 scope="sessions:send · sessions:launch">2 · Sessions</H2>
      <div className="card">
        <div className="row">
          <label className="f">command<input value={cmd} onChange={e => setCmd(e.target.value)} style={{ width: 220 }} /></label>
          <label className="f">cwd<input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="(default)" style={{ width: 140 }} /></label>
          <label className="f">name<input value={name} onChange={e => setName(e.target.value)} style={{ width: 110 }} /></label>
          <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={launch}>Launch session</button>
        </div>
      </div>
      <div>
        {!sessions.length ? <div className="empty">no live sessions — launch one above</div>
          : sessions.map(s => <SessionCard key={s.id} s={s} api={api} guard={guard} />)}
      </div>
    </>
  )
}
function SessionCard({ s, api, guard }: { s: SnapshotSession; api: Api; guard: ReturnType<typeof useYaam>['guard'] }) {
  const [out, setOut] = useState<string | null>(null)
  return (
    <div className="card sess row">
      <span className={'dot ' + (s.status === 'running' ? 'running' : s.status === 'needs' ? 'err' : 'on')} />
      <span className="nm">{s.name}</span>
      <span className="meta grow">{`${s.status} · $${s.cost}${s.machineId ? ' · remote' : ''}${s.isolated ? ' · ⑂' : ''}`}</span>
      <button onClick={async () => setOut((await guard(api.sessions.readOutput(s.id, 15), '')) || '(no output)')}>read output</button>
      <button onClick={() => guard(api.sendToSession(s.id, 'hello from the kitchen sink'))}>send line</button>
      <button onClick={() => guard(api.focusSession(s.id))}>focus</button>
      <ConfirmButton className="danger" onConfirm={() => guard(api.sessions.stop(s.id))}>stop</ConfirmButton>
      {out !== null && <pre style={{ width: '100%' }}>{out}</pre>}
    </div>
  )
}

// ---------- 3 · tasks ----------
function SectionTasks({ snap }: { snap: Snap }) {
  const { api, guard } = useYaam()
  const [title, setTitle] = useState('kitchen-sink demo task')
  const [col, setCol] = useState('backlog')
  const [mode, setMode] = useState('')
  const [when, setWhen] = useState('')
  const [desc, setDesc] = useState('Say hello and exit — created by the Dev Kitchen Sink addon.')
  const [iso, setIso] = useState(false)
  const [start, setStart] = useState(false)
  const add = async () => {
    const id = await guard(api.tasks.add(title, col, {
      description: desc, criteria: ['the session ran and exited cleanly'],
      isolate: iso || undefined, sessionMode: (mode as 'interactive' | '') || undefined,
      scheduleAt: when ? Date.now() + Number(when) * 60000 : undefined,
    }))
    if (id && start && !when) await guard(api.tasks.start(id))
  }
  const tasks = (snap ? snap.tasks : []).slice(-8).reverse()
  return (
    <>
      <H2 scope="tasks — full spec + review verbs">3 · Tasks</H2>
      <div className="card">
        <div className="row">
          <label className="f">title<input value={title} onChange={e => setTitle(e.target.value)} style={{ width: 200 }} /></label>
          <label className="f">column<select value={col} onChange={e => setCol(e.target.value)}><option>backlog</option><option>progress</option><option>review</option></select></label>
          <label className="f">session<select value={mode} onChange={e => setMode(e.target.value)}><option value="">one-shot</option><option value="interactive">interactive</option></select></label>
          <label className="f">start in<select value={when} onChange={e => setWhen(e.target.value)}><option value="">now / manual</option><option value="2">2 min (scheduleAt)</option><option value="10">10 min</option></select></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="f grow">description<input value={desc} onChange={e => setDesc(e.target.value)} /></label>
          <label className="chk" style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={iso} onChange={e => setIso(e.target.checked)} /> worktree ⑂</label>
          <label className="chk" style={{ alignSelf: 'flex-end' }}><input type="checkbox" checked={start} onChange={e => setStart(e.target.checked)} /> start now</label>
          <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={add}>Create</button>
        </div>
      </div>
      <div>
        {!tasks.length ? <div className="empty">no tasks — create one above</div>
          : tasks.map(t => <TaskCard key={t.id} t={t} api={api} guard={guard} />)}
      </div>
    </>
  )
}
function TaskCard({ t, api, guard }: { t: SnapshotTask; api: Api; guard: ReturnType<typeof useYaam>['guard'] }) {
  const [detail, setDetail] = useState<string | null>(null)
  const pillCls = t.col === 'done' ? 'done' : t.col === 'failed' ? 'failed' : t.col === 'review' ? 'warn' : 'mut'
  const meta = `${t.sessionMode}${t.isolate ? ' · ⑂' : ''}${t.scheduleAt ? ' · starts ' + new Date(t.scheduleAt).toLocaleTimeString() : ''}${t.watcherNote ? ' · ' + t.watcherNote.slice(0, 40) : ''}`
  return (
    <div className="card task row">
      <span className={'pill ' + pillCls}>{t.col}</span>
      <span className="nm">{t.title}</span>
      <span className="meta grow">{meta}</span>
      <button onClick={async () => setDetail(pretty(await guard(api.tasks.get(t.id))))}>get</button>
      {t.col === 'backlog' && <button className="primary" onClick={() => guard(api.tasks.start(t.id))}>▶ start</button>}
      {t.col === 'review' && <button className="primary" onClick={() => guard(api.tasks.approve(t.id))}>✓ approve</button>}
      {t.col === 'review' && <button onClick={() => guard(api.tasks.reject(t.id, 'sent back by the kitchen sink — please double-check'))}>↩ reject</button>}
      <ConfirmButton className="ghost danger" label="✕ sure?" onConfirm={() => guard(api.tasks.remove(t.id))}>✕</ConfirmButton>
      {detail !== null && <pre style={{ width: '100%' }}>{detail}</pre>}
    </div>
  )
}

// ---------- 4 · templates ----------
function SectionTemplates({ snap }: { snap: Snap }) {
  const { api, guard } = useYaam()
  const tpls = snap ? snap.templates : []
  return (
    <>
      <H2 scope="templates.list / templates.run">4 · Templates</H2>
      <div className="card">
        {!tpls.length ? <div className="empty">no templates defined in this workspace (Templates view)</div>
          : tpls.map(t => (
            <div key={t.id} className="lrow">
              <span>{t.name}</span>
              <span className="meta grow">{t.mode}</span>
              <button onClick={() => guard(api.templates.run(t.id, 'say hello — kitchen-sink template run'))}>run with task</button>
            </div>
          ))}
      </div>
    </>
  )
}

// ---------- 5 · schedules ----------
function SectionSchedules({ snap }: { snap: Snap }) {
  const { api, guard } = useYaam()
  const [name, setName] = useState('sink-heartbeat')
  const [cron, setCron] = useState('*/5 * * * *')
  const [at, setAt] = useState('')
  const addSchedule = async () => {
    const spec = at ? { name, at: Date.now() + Number(at) * 60000 } : { name, schedule: cron }
    const res = await guard(api.schedules.add(spec))
    if (typeof res === 'string') api.flash(res.slice(0, 76)).catch(() => {})
  }
  return (
    <>
      <H2 scope="schedules + run history">5 · Schedules</H2>
      <div className="card row">
        <label className="f">name<input value={name} onChange={e => setName(e.target.value)} style={{ width: 130 }} /></label>
        <label className="f">cron<input className="mono" value={cron} onChange={e => setCron(e.target.value)} style={{ width: 110 }} /></label>
        <label className="f">or one-time in<select value={at} onChange={e => setAt(e.target.value)}><option value="">use cron</option><option value="2">2 min</option><option value="5">5 min</option></select></label>
        <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={addSchedule}>Add schedule</button>
        <span className="grow" />
        <span className="meta">firing = an onCronFired hook + a row in §9</span>
      </div>
      <div>
        {!(snap && snap.crons.length) ? <div className="empty">no schedules — add the heartbeat above and watch §9 catch its onCronFired</div>
          : snap!.crons.map(c => <CronCard key={c.name} c={c} api={api} guard={guard} />)}
      </div>
    </>
  )
}
function CronCard({ c, api, guard }: { c: SnapshotCron; api: Api; guard: ReturnType<typeof useYaam>['guard'] }) {
  const runs = (c.runs || []).map(r => (r.ok ? '✓' : '✗')).join(' ') || 'no runs'
  const sched = (c.schedule || (c.at ? 'once ' + new Date(c.at).toLocaleTimeString() : '')) + ' · ' + c.action + ' · last: ' + c.last
  return (
    <div className="card row">
      <span className={'dot ' + (c.on ? 'on' : '')} />
      <span style={{ fontWeight: 600, fontSize: 12 }}>{c.name}</span>
      <span className="meta">{sched}</span>
      <span className="meta grow">{runs}</span>
      <button onClick={() => guard(api.schedules.toggle(c.name))}>{c.on ? 'pause' : 'resume'}</button>
      <ConfirmButton className="ghost danger" label="✕ sure?" onConfirm={() => guard(api.schedules.remove(c.name))}>✕</ConfirmButton>
    </div>
  )
}

// ---------- 6 · storage ----------
function SectionStorage() {
  const { api, guard } = useYaam()
  const [key, setKey] = useState('demo')
  const [val, setVal] = useState('{"hello":"world"}')
  const [out, setOut] = useState('keys: …')
  const keys = async () => { const k = await guard(api.storage.list(), []); return 'keys: ' + (k && k.length ? k.join(', ') : '(none)') }
  useEffect(() => { keys().then(setOut) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const set = async () => { let v: unknown = val; try { v = JSON.parse(val) } catch { /* plain string */ } await guard(api.storage.set(key, v)); setOut(await keys()) }
  const get = async () => { const v = await guard(api.storage.get(key)); setOut(pretty(v) + '\n\n' + await keys()) }
  const del = async () => { await guard(api.storage.remove(key)); setOut(await keys()) }
  return (
    <>
      <H2 scope="get / set / list / remove · 256 KB per value">6 · Storage</H2>
      <div className="card">
        <div className="row">
          <label className="f">key<input value={key} onChange={e => setKey(e.target.value)} style={{ width: 120 }} /></label>
          <label className="f grow">value (JSON or plain text)<input value={val} onChange={e => setVal(e.target.value)} /></label>
          <button onClick={set} style={{ alignSelf: 'flex-end' }}>set</button>
          <button onClick={get} style={{ alignSelf: 'flex-end' }}>get</button>
          <button className="danger" onClick={del} style={{ alignSelf: 'flex-end' }}>remove</button>
        </div>
        <pre>{out}</pre>
      </div>
    </>
  )
}

// ---------- 7 · http + secrets ----------
function SectionHttp() {
  const { api } = useYaam()
  const [method, setMethod] = useState('GET')
  const [url, setUrl] = useState('https://api.github.com/zen')
  const [head, setHead] = useState('{"accept": "application/vnd.github+json"}')
  const [out, setOut] = useState('response appears here — try a disallowed host to see the allowlist reject it')
  const [busy, setBusy] = useState(false)
  const [secretsLine, setSecretsLine] = useState('secrets: …')
  useEffect(() => {
    api.secrets.list().then(
      list => setSecretsLine('secrets: ' + list.map(s => `${s.name} ${s.set ? '● set' : '○ unset'}`).join(' · ') + ' — values live in the OS keychain; set them in the Addons view'),
      () => setSecretsLine('secrets: grant the "secrets" scope to list slots'),
    )
  }, [api])
  const go = async () => {
    setBusy(true)
    try {
      let headers: Record<string, string>
      try { headers = JSON.parse(head || '{}') } catch { banner('headers must be JSON'); setBusy(false); return }
      const res = await api.http.request(method, url, { headers })
      setOut(`HTTP ${res.status} · ${res.contentType}\n\n${res.text.slice(0, 4000)}`)
    } catch (e) { setOut('✗ ' + (e as Error).message) }
    setBusy(false)
  }
  return (
    <>
      <H2 scope="http (host-allowlisted) · secrets (keychain, write-only)">7 · HTTP + secrets</H2>
      <div className="sect-note">this addon declares <span className="mono">hosts: [api.github.com]</span> — anything else is rejected before it leaves the app. Header/body values may embed <span className="mono">{'{{secret:DEMO_TOKEN}}'}</span>; the value is injected host-side and never enters addon code.</div>
      <div className="card">
        <div className="row">
          <label className="f">method<select value={method} onChange={e => setMethod(e.target.value)}><option>GET</option><option>POST</option></select></label>
          <label className="f grow">url (must match the hosts allowlist)<input className="mono" value={url} onChange={e => setUrl(e.target.value)} /></label>
          <button className="primary" disabled={busy} style={{ alignSelf: 'flex-end' }} onClick={go}>Send</button>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="f grow">headers (JSON — try {'{"x-demo": "{{secret:DEMO_TOKEN}}"}'})<input className="mono" value={head} onChange={e => setHead(e.target.value)} /></label>
        </div>
        <pre>{out}</pre>
        <div className="row" style={{ marginTop: 6 }}><span className="meta">{secretsLine}</span></div>
      </div>
    </>
  )
}

// ---------- 8 · agent ----------
function SectionAgent() {
  const { api, guard } = useYaam()
  const [msg, setMsg] = useState('')
  const [chat, setChat] = useState<{ role: 'you' | 'bot'; text: string }[]>([])
  const [busy, setBusy] = useState(false)
  const chatRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight }, [chat])
  const wake = async () => {
    const m = msg.trim(); if (!m) return
    setMsg(''); setChat(c => [...c, { role: 'you', text: m }]); setBusy(true)
    const reply = await guard(api.agent.wake(m), '(agent unavailable)')
    setChat(c => [...c, { role: 'bot', text: String(reply) }]); setBusy(false)
  }
  return (
    <>
      <H2 scope="agent.wake → its tools are this addon's API">8 · The addon's agent</H2>
      <div className="sect-note">the same harness the GitHub-issues triage and usage-limit monitors use — its instructions live in <span className="mono">prompts/agent.md</span> and are editable via the addon's Customize chat. Add <span className="mono">every:</span>/<span className="mono">on:</span> in the manifest to wake it on crons/events.</div>
      <div className="card">
        <div ref={chatRef} style={{ display: 'flex', flexDirection: 'column' }}>
          {chat.map((b, i) => <div key={i} className={'bubble ' + b.role}>{b.text}</div>)}
        </div>
        <div className="row">
          <input className="grow" value={msg} onChange={e => setMsg(e.target.value)} placeholder={'try: "how many sessions are running? store the answer under key agent-note"'} onKeyDown={e => { if (e.key === 'Enter') void wake() }} />
          <button className="primary" disabled={busy} onClick={wake}>{busy ? <><span className="spin">✳</span> thinking…</> : 'Wake agent'}</button>
        </div>
      </div>
    </>
  )
}

// ---------- 9 · ui calls + hook log ----------
function SectionUiHooks({ snap, guard, api }: { snap: Snap; guard: ReturnType<typeof useYaam>['guard']; api: Api }) {
  const [log, setLog] = useState<{ at: number; event: unknown }[]>([])
  useEffect(() => {
    guard(api.storage.get('hookLog'), null).then(l => { if (Array.isArray(l)) setLog(l as { at: number; event: unknown }[]) })
  }, [snap]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <H2 scope="ui · hooks: onSessionExit / onNeedsInput / onTaskMoved / onCronFired">9 · UI calls + hook log</H2>
      <div className="card row">
        <button onClick={() => guard(api.flash('flash from the kitchen sink'))}>flash()</button>
        <button onClick={() => guard(api.notify('Kitchen sink', 'notify() lands in the bell popover'))}>notify()</button>
        <button onClick={() => guard(api.logEvent('logEvent() lands in the Activity timeline'))}>logEvent()</button>
        <span className="grow" />
        <span className="meta">all four hooks append to the log below (hooks/log.js)</span>
      </div>
      <div className="card">
        {!log.length ? <span className="empty">no hook events yet — exit a session, move a task, or let a schedule fire</span>
          : <div>{log.slice(0, 20).map((x, i) => (
            <div key={i} className="lrow"><span className="meta">{agoFn(x.at)}</span><span className="mono" style={{ fontSize: 10.5, color: 'var(--mut)' }}>{JSON.stringify(x.event)}</span></div>
          ))}</div>}
      </div>
    </>
  )
}
