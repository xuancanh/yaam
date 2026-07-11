import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import type { Cron } from '../../core/types'
import { IC, Icon, Switch, ViewHeader } from '../../components/ui'
import { SpecVerifyDialog, TaskSpecFields, emptyTaskSpec, useTaskSpecAssist } from '../board/TaskSpecForm'
import type { TaskSpecPatch, VerifyOutcome } from '../board/TaskSpecForm'
import { buildCron, cronFireMinutesOnDay, cronFiresOnDay, cronTimeLabel, describeCron } from './cron'
import type { SimpleSchedule } from './cron'
import { confirmAction } from '../../components/Confirm'

/** default for the one-time picker: next full hour, in datetime-local format */
function nextHourLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
  fontFamily: 'var(--font-mono)',
} as const

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Human-friendly recurring editor: frequency + the fields it needs. The raw
 *  crontab stays one toggle away, both share the same live description. */
function SimpleEditor({ sp, set }: { sp: SimpleSchedule; set: (sp: SimpleSchedule) => void }) {
  const num = (v: string, fallback: number) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
  }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={sp.freq} onChange={e => set({ ...sp, freq: e.target.value as SimpleSchedule['freq'] })} className="select-field" style={{ ...FIELD, width: 'auto', flex: 1, minWidth: 130 }}>
        <option value="minutes">Every N minutes</option>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      {sp.freq === 'minutes' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--mut)' }}>
          every
          <input type="number" min={1} max={59} value={sp.every} onChange={e => set({ ...sp, every: num(e.target.value, 1) })} style={{ ...FIELD, width: 64 }} />
          min
        </label>
      )}
      {sp.freq === 'weekly' && (
        <select value={sp.dow} onChange={e => set({ ...sp, dow: num(e.target.value, 1) })} className="select-field" style={{ ...FIELD, width: 'auto' }}>
          {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
      )}
      {sp.freq === 'monthly' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--mut)' }}>
          day
          <input type="number" min={1} max={31} value={sp.dom} onChange={e => set({ ...sp, dom: num(e.target.value, 1) })} style={{ ...FIELD, width: 64 }} />
        </label>
      )}
      {sp.freq !== 'minutes' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--mut)' }}>
          {sp.freq === 'hourly' ? 'at minute' : 'at'}
          {sp.freq === 'hourly'
            ? <input type="number" min={0} max={59} value={parseInt(sp.time.split(':')[1] ?? '0', 10) || 0} onChange={e => set({ ...sp, time: `${sp.time.split(':')[0] ?? '09'}:${String(num(e.target.value, 0)).padStart(2, '0')}` })} style={{ ...FIELD, width: 64 }} />
            : <input type="time" value={sp.time} onChange={e => set({ ...sp, time: e.target.value || '09:00' })} style={{ ...FIELD, width: 'auto', colorScheme: 'dark' }} />}
        </label>
      )}
    </div>
  )
}

/** Collect and normalize recurring or one-time schedule configuration. */
function NewScheduleDialog({ onClose }: { onClose: () => void }) {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { addCron } = useActions()
  const [kind, setKind] = useState<'cron' | 'once'>('cron')
  const [name, setName] = useState('')
  // recurring: friendly builder by default; raw crontab one toggle away
  const [cronMode, setCronMode] = useState<'simple' | 'crontab'>('simple')
  const [simple, setSimple] = useState<SimpleSchedule>({ freq: 'daily', every: 10, time: '09:00', dow: 1, dom: 1 })
  const [rawCron, setRawCron] = useState('0 9 * * *')
  const [at, setAt] = useState(nextHourLocal())
  const [action, setAction] = useState<'command' | 'task'>('command')
  const [cmd, setCmd] = useState('')
  const [cwd, setCwd] = useState('')
  // the task action uses the exact same spec form + verify gate as the board's
  // New-task dialog — templates are picked there as "Run with"
  const [spec, setSpec] = useState(() => emptyTaskSpec(s.settings.defaultCwd || ''))
  const [startNow, setStartNow] = useState(true)
  const { busy, error, llmOn, verifyForCreate } = useTaskSpecAssist(spec)
  const [confirm, setConfirm] = useState<Extract<VerifyOutcome, { kind: 'ai' | 'questions' }> | null>(null)

  const schedule = cronMode === 'simple' ? buildCron(simple) : rawCron.trim()
  const meaning = describeCron(schedule)
  const atMs = kind === 'once' ? new Date(at).getTime() : 0
  const valid = Boolean(name.trim())
    && (kind === 'cron' ? meaning.ok : Number.isFinite(atMs) && atMs > Date.now())
    && (action !== 'task' || Boolean(spec.title.trim()))

  // Persist the normalized Cron record with the given (verified) task spec.
  const doCreate = (taskPatch?: TaskSpecPatch) => {
    const once = kind === 'once'
    addCron({
      name: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      schedule: once ? '' : schedule,
      human: once
        ? `once · ${new Date(atMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : meaning.text,
      at: once ? atMs : undefined,
      target: cwd.trim() ? cwd.trim().split('/').pop() || cwd.trim() : 'workspace',
      agent: action === 'task' ? 'Board' : cmd.trim() ? cmd.trim().split(/\s+/)[0] : 'Master',
      color: ACCENT,
      cmd: action === 'command' ? cmd.trim() || undefined : undefined,
      cwd: action === 'command' ? cwd.trim() || undefined : undefined,
      boardTask: taskPatch ? { ...taskPatch, startNow } : undefined,
    })
    onClose()
  }

  // Task schedules go through the same verify gate as board task creation;
  // AI feedback lands in the confirmation popup, never applied silently.
  const create = async () => {
    if (!valid || busy) return
    if (action !== 'task') { doCreate(); return }
    const out = await verifyForCreate()
    if (!out) return
    if (out.kind === 'create') doCreate(out.patch)
    else setConfirm(out)
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '10vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 540, maxWidth: '92vw', maxHeight: '84vh', overflowY: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New schedule</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          Run once at a future time, or recur. With a command set, each run launches a live session.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9, padding: 4 }}>
            {([['cron', 'Recurring'], ['once', 'One-time · run at']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                style={{
                  flex: 1, padding: '7px 0', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600,
                  background: kind === k ? hexToRgba(ACCENT, 0.16) : 'transparent',
                  color: kind === k ? 'var(--accent)' : 'var(--mut)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="name · e.g. nightly-regression" style={FIELD} />
          {kind === 'cron' ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  {cronMode === 'simple'
                    ? <SimpleEditor sp={simple} set={setSimple} />
                    : <input value={rawCron} onChange={e => setRawCron(e.target.value)} placeholder="cron · min hour day-of-month month weekday" style={FIELD} />}
                </div>
                <button
                  className="open-btn"
                  title={cronMode === 'simple' ? 'Edit the raw crontab expression' : 'Back to the friendly editor'}
                  style={{ flex: 'none', padding: '7px 11px', fontSize: 11, color: cronMode === 'crontab' ? 'var(--accent)' : undefined }}
                  onClick={() => {
                    // seed the raw editor from the friendly one on the way over
                    if (cronMode === 'simple') setRawCron(buildCron(simple))
                    setCronMode(m => (m === 'simple' ? 'crontab' : 'simple'))
                  }}
                >
                  {cronMode === 'simple' ? 'crontab' : 'simple'}
                </button>
              </div>
              <div className="mono" style={{ fontSize: 11, color: meaning.ok ? 'var(--dim)' : 'var(--red-soft)', paddingLeft: 2 }}>
                {meaning.ok ? `${meaning.text} · ${schedule}` : meaning.text}
              </div>
            </div>
          ) : (
            <div>
              <input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} style={{ ...FIELD, colorScheme: 'dark' }} />
              <div style={{ fontSize: 11, color: Number.isFinite(atMs) && atMs > Date.now() ? 'var(--dim)' : 'var(--red-soft)', marginTop: 4, paddingLeft: 2 }}>
                {Number.isFinite(atMs) && atMs > Date.now()
                  ? `fires once · ${new Date(atMs).toLocaleString()}`
                  : 'pick a time in the future'}
              </div>
            </div>
          )}
          <select value={action} onChange={e => setAction(e.target.value as 'command' | 'task')} className="select-field" style={FIELD}>
            <option value="command">action · run a command</option>
            <option value="task">action · add a task to the board (template via “Run with”)</option>
          </select>
          {action === 'command' && (
            <>
              <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="command (optional) · e.g. claude -p 'run the tests'" style={FIELD} />
              <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working directory (optional)" style={FIELD} />
            </>
          )}
          {action === 'task' && (
            <>
              <TaskSpecFields v={spec} set={setSpec} questions={[]} error={error} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px 0' }}>
                <div style={{ flex: 1, fontSize: 11.5, color: 'var(--mut)' }}>
                  Start when it fires <span style={{ color: 'var(--dim)' }}>— the watcher spawns its session immediately; off = lands in Backlog</span>
                </div>
                <Switch on={startNow} onToggle={() => setStartNow(v => !v)} />
              </div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: valid && !busy ? 1 : 0.45 }} onClick={() => { void create() }} disabled={!valid || busy}>
            {busy ? 'Verifying…' : action === 'task' && llmOn ? 'Verify & create schedule' : 'Create schedule'}
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={onClose}>Cancel</button>
        </div>
      </div>
      {confirm && <SpecVerifyDialog outcome={confirm} onCreate={p => doCreate(p)} onClose={() => setConfirm(null)} />}
    </div>
  )
}

/** Expandable newest-first firing log for one schedule, with jump links. */
function RunHistory({ cron }: { cron: Cron }) {
  const s = useConductorSelector(x => ({ agents: x.agents }), shallowEqual)
  const { focusTab, setView } = useActions()
  const runs = cron.runs ?? []
  if (!runs.length) {
    return <div style={{ padding: '8px 14px 10px 58px', fontSize: 11.5, color: 'var(--dim)' }}>No runs recorded yet — history starts with the next firing.</div>
  }
  return (
    <div style={{ padding: '2px 14px 10px 58px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((r, i) => {
        const agent = r.agentId ? s.agents.find(a => a.id === r.agentId) : undefined
        return (
          <div key={`${r.at}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 11.5, color: 'var(--mut)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: r.ok ? 'var(--green)' : 'var(--red-soft)' }} />
            <span className="mono" style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--dim)' }}>
              {new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.note}</span>
            {agent && (
              <button
                onClick={() => focusTab(agent.id)}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 600, padding: 0, flexShrink: 0, cursor: 'pointer' }}
              >
                open session →
              </button>
            )}
            {r.taskId && !agent && (
              <button
                onClick={() => setView('board')}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 600, padding: 0, flexShrink: 0, cursor: 'pointer' }}
              >
                view board →
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** True when the epoch timestamp falls on the given local calendar day. */
function sameDay(ms: number, d: Date): boolean {
  const x = new Date(ms)
  return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate()
}

/** Sort key so a day's chips read top-to-bottom in firing order. */
function chipMinutes(c: Cron): number {
  if (c.at) {
    const d = new Date(c.at)
    return d.getHours() * 60 + d.getMinutes()
  }
  const [min, hour] = c.schedule.trim().split(/\s+/)
  return (/^\d+$/.test(hour) ? parseInt(hour, 10) * 60 : 0) + (/^\d+$/.test(min) ? parseInt(min, 10) : 0)
}

/** One day cell: date number plus a chip per schedule firing that day and a
 *  compact ✓/✕ tally of runs already recorded on it. */
function CalendarDay({ day, inMonth, crons }: { day: Date; inMonth: boolean; crons: Cron[] }) {
  const today = sameDay(Date.now(), day)
  const fires = crons
    .filter(c => (c.at ? sameDay(c.at, day) : c.on && cronFiresOnDay(c.schedule, day)))
    .sort((a, b) => chipMinutes(a) - chipMinutes(b))
  const runs = crons.flatMap(c => (c.runs ?? []).filter(r => sameDay(r.at, day)))
  const ok = runs.filter(r => r.ok).length
  const failed = runs.length - ok
  const shown = fires.slice(0, 3)
  return (
    <div style={{
      minHeight: 92, padding: '6px 7px', borderRight: '1px solid var(--line-soft)', borderBottom: '1px solid var(--line-soft)',
      background: inMonth ? 'transparent' : 'var(--bg2)', opacity: inMonth ? 1 : 0.45,
      display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="mono" style={{
          fontSize: 10.5, fontWeight: today ? 700 : 500, width: 20, height: 20, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: today ? 'var(--bg)' : 'var(--dim)', background: today ? 'var(--accent)' : 'transparent',
        }}>
          {day.getDate()}
        </span>
        {(ok > 0 || failed > 0) && (
          <span className="mono" style={{ fontSize: 9.5, marginLeft: 'auto', flexShrink: 0 }} title={`${runs.length} recorded run${runs.length === 1 ? '' : 's'} on this day`}>
            {ok > 0 && <span style={{ color: 'var(--green)' }}>✓{ok}</span>}
            {failed > 0 && <span style={{ color: 'var(--red-soft)', marginLeft: 4 }}>✕{failed}</span>}
          </span>
        )}
      </div>
      {shown.map(c => {
        const time = c.at ? new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : cronTimeLabel(c.schedule)
        const done = !!c.at && !c.on
        return (
          <div
            key={c.id}
            className="mono"
            title={`${c.name} · ${c.at ? `one-time${done ? ' · done' : ''} · ${new Date(c.at).toLocaleString()}` : describeCron(c.schedule).text}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, padding: '2px 6px', borderRadius: 5,
              background: 'var(--panel2)', border: '1px solid var(--line-soft)', minWidth: 0,
              opacity: done ? 0.5 : 1,
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--dim)', flexShrink: 0 }}>{time}</span>
            <span style={{ color: 'var(--text2)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
          </div>
        )
      })}
      {fires.length > shown.length && (
        <div className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', paddingLeft: 2 }} title={fires.slice(3).map(c => c.name).join(', ')}>
          +{fires.length - shown.length} more
        </div>
      )}
    </div>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// time-grid geometry (week/day views): pixels per hour and per chip
const HOUR_H = 44
const CHIP_H = 18

interface DayFire {
  cron: Cron
  /** minute-of-day */
  minute: number
  done?: boolean
}

/** Everything a schedule contributes to one day. Dense recurring schedules
 *  (> 24 firings, e.g. "every 10 min") collapse into an all-day banner instead
 *  of wallpapering the column with chips. */
function firesForDay(crons: Cron[], day: Date): { timed: DayFire[]; allDay: Cron[] } {
  const timed: DayFire[] = []
  const allDay: Cron[] = []
  for (const c of crons) {
    if (c.at) {
      if (sameDay(c.at, day)) {
        const d = new Date(c.at)
        timed.push({ cron: c, minute: d.getHours() * 60 + d.getMinutes(), done: !c.on })
      }
      continue
    }
    if (!c.on) continue
    const minutes = cronFireMinutesOnDay(c.schedule, day, 25)
    if (minutes.length > 24) allDay.push(c)
    else timed.push(...minutes.map(minute => ({ cron: c, minute })))
  }
  timed.sort((a, b) => a.minute - b.minute)
  return { timed, allDay }
}

/** ✓/✕ tally of runs recorded on one day (shared by all calendar views). */
function RunTally({ crons, day }: { crons: Cron[]; day: Date }) {
  const runs = crons.flatMap(c => (c.runs ?? []).filter(r => sameDay(r.at, day)))
  const ok = runs.filter(r => r.ok).length
  const failed = runs.length - ok
  if (!runs.length) return null
  return (
    <span className="mono" style={{ fontSize: 9.5, flexShrink: 0 }} title={`${runs.length} recorded run${runs.length === 1 ? '' : 's'} on this day`}>
      {ok > 0 && <span style={{ color: 'var(--green)' }}>✓{ok}</span>}
      {failed > 0 && <span style={{ color: 'var(--red-soft)', marginLeft: 4 }}>✕{failed}</span>}
    </span>
  )
}

/** Outlook-style time grid for one or more days: hour rows, chips positioned
 *  at their firing minute, all-day banners on top, and a live now-line. */
function TimeGrid({ days, crons }: { days: Date[]; crons: Cron[] }) {
  // the now-line tracks the clock while the view is open
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const iv = window.setInterval(() => setNowTick(Date.now()), 30_000)
    return () => window.clearInterval(iv)
  }, [])
  const now = new Date(nowTick)
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const perDay = days.map(day => ({ day, ...firesForDay(crons, day) }))
  const anyAllDay = perDay.some(d => d.allDay.length > 0)

  const chip = (c: Cron, key: string, label: string, extra?: CSSProperties, done?: boolean) => (
    <div
      key={key}
      className="mono"
      title={`${c.name} · ${c.at ? `one-time${done ? ' · done' : ''} · ${new Date(c.at).toLocaleString()}` : describeCron(c.schedule).text}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, padding: '0 6px', borderRadius: 5,
        background: 'var(--panel2)', border: '1px solid var(--line-soft)', minWidth: 0, height: CHIP_H,
        opacity: done ? 0.5 : 1, overflow: 'hidden', ...extra,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
      <span style={{ color: 'var(--dim)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text2)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
    </div>
  )

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 13, overflow: 'hidden', background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* day headers (+ all-day banner lane) */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
        <div style={{ width: 52, flexShrink: 0 }} />
        {perDay.map(({ day, allDay }) => {
          const today = sameDay(nowTick, day)
          return (
            <div key={day.toISOString()} style={{ flex: 1, minWidth: 0, padding: '7px 8px 6px', borderLeft: '1px solid var(--line-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: today ? 'var(--accent)' : 'var(--dim)' }}>
                  {WEEKDAYS[day.getDay()].toUpperCase()}
                </span>
                <span className="mono" style={{
                  fontSize: 11.5, fontWeight: today ? 700 : 500, minWidth: 20, height: 20, padding: '0 3px', borderRadius: 10,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  color: today ? 'var(--bg)' : 'var(--text2)', background: today ? 'var(--accent)' : 'transparent',
                }}>
                  {day.getDate()}
                </span>
                <div style={{ flex: 1 }} />
                <RunTally crons={crons} day={day} />
              </div>
              {anyAllDay && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 5, minHeight: CHIP_H }}>
                  {allDay.map(c => chip(c, c.id, cronTimeLabel(c.schedule)))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {/* scrollable hour grid */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={{ display: 'flex', height: 24 * HOUR_H, position: 'relative' }}>
          <div style={{ width: 52, flexShrink: 0, position: 'relative' }}>
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="mono" style={{ position: 'absolute', top: (i + 1) * HOUR_H - 7, right: 8, fontSize: 9.5, color: 'var(--faint)' }}>
                {String(i + 1).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {perDay.map(({ day, timed }) => {
            const today = sameDay(nowTick, day)
            // same-minute firings share the row side by side
            const byMinute = new Map<number, DayFire[]>()
            for (const f of timed) byMinute.set(f.minute, [...(byMinute.get(f.minute) ?? []), f])
            return (
              <div key={day.toISOString()} style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--line-soft)', background: today ? 'rgba(245,196,81,.025)' : 'transparent' }}>
                {Array.from({ length: 23 }, (_, i) => (
                  <div key={i} style={{ position: 'absolute', top: (i + 1) * HOUR_H, left: 0, right: 0, borderTop: '1px solid var(--line-soft)' }} />
                ))}
                {[...byMinute.entries()].map(([minute, group]) => (
                  <div key={minute} style={{ position: 'absolute', top: (minute / 60) * HOUR_H, left: 2, right: 3, display: 'flex', gap: 2, zIndex: 1 }}>
                    {group.map((f, i) => chip(
                      f.cron, `${f.cron.id}-${minute}-${i}`,
                      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
                      { flex: 1, minWidth: 0 }, f.done,
                    ))}
                  </div>
                ))}
                {today && (
                  <div style={{ position: 'absolute', top: (nowMinute / 60) * HOUR_H, left: 0, right: 0, zIndex: 2, pointerEvents: 'none' }}>
                    <div style={{ borderTop: '1.5px solid var(--red-soft)' }} />
                    <span style={{ position: 'absolute', left: -3, top: -3, width: 6, height: 6, borderRadius: '50%', background: 'var(--red-soft)' }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

type CalRange = 'month' | 'week' | 'day'

/** Calendar of schedule firings — Outlook-style Month / Week / Day views:
 *  recurring crons projected onto their firing days and times, one-time runs
 *  on their date, and recorded runs as ✓/✕. */
function ScheduleCalendar({ crons }: { crons: Cron[] }) {
  const now = new Date()
  const [range, setRange] = useState<CalRange>('month')
  // anchor date: any day inside the shown month/week, or the shown day
  const [anchor, setAnchor] = useState(() => new Date(now.getFullYear(), now.getMonth(), now.getDate()))
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - first.getDay())
  const weeks: Date[][] = []
  for (let w = 0; w < 6; w++) {
    const week = Array.from({ length: 7 }, (_, i) => new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate() + w * 7 + i))
    if (w > 0 && week[0].getMonth() !== anchor.getMonth()) break // trim weeks fully past the month
    weeks.push(week)
  }
  const weekDays = Array.from({ length: 7 }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay() + i))

  const step = (dir: number) => setAnchor(a => range === 'month'
    ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
    : new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir * (range === 'week' ? 7 : 1)))
  const isCurrent = range === 'month'
    ? anchor.getFullYear() === now.getFullYear() && anchor.getMonth() === now.getMonth()
    : range === 'week'
      ? weekDays.some(d => sameDay(Date.now(), d))
      : sameDay(Date.now(), anchor)
  const title = range === 'month'
    ? first.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : range === 'week'
      ? `${weekDays[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
      : anchor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexShrink: 0 }}>
        <button className="icon-btn" title={`Previous ${range}`} style={{ width: 26, height: 26, borderRadius: 7 }} onClick={() => step(-1)}>
          <Icon paths={['M15 6l-6 6 6 6']} size={13} stroke={1.8} />
        </button>
        <button className="icon-btn" title={`Next ${range}`} style={{ width: 26, height: 26, borderRadius: 7 }} onClick={() => step(1)}>
          <Icon paths={['M9 6l6 6-6 6']} size={13} stroke={1.8} />
        </button>
        <span className="grotesk" style={{ fontSize: 14.5, fontWeight: 600, marginLeft: 4 }}>{title}</span>
        {!isCurrent && (
          <button className="open-btn" style={{ flex: 'none', padding: '4px 12px', fontSize: 11.5 }} onClick={() => setAnchor(new Date(now.getFullYear(), now.getMonth(), now.getDate()))}>
            Today
          </button>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--dim)' }}>
          recurring schedules appear at every firing · ✓/✕ = recorded runs
        </span>
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 9, padding: 2, flexShrink: 0 }}>
          {(['month', 'week', 'day'] as const).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                border: 'none', borderRadius: 7, padding: '3px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: range === r ? 'var(--panel2)' : 'transparent',
                color: range === r ? 'var(--accent)' : 'var(--mut)',
                textTransform: 'capitalize',
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {range === 'month' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 13, overflow: 'hidden', background: 'var(--panel)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
              {WEEKDAYS.map(d => (
                <div key={d} className="mono" style={{ padding: '7px 0', textAlign: 'center', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--dim)', borderBottom: '1px solid var(--line)' }}>
                  {d.toUpperCase()}
                </div>
              ))}
              {weeks.flat().map(day => (
                <CalendarDay key={day.toISOString()} day={day} inMonth={day.getMonth() === anchor.getMonth()} crons={crons} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <TimeGrid days={range === 'week' ? weekDays : [anchor]} crons={crons} />
      )}
    </div>
  )
}

/** List, toggle, remove, and create schedules for the active workspace. */
export function Schedules() {
  const s = useConductorSelector(x => ({ crons: x.crons, templates: x.templates }), shallowEqual)
  const { toggleCron, deleteCron } = useActions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'calendar'>('list')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Schedules">
        <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 9, padding: 2, flexShrink: 0 }}>
          {([['list', 'List'], ['calendar', 'Calendar']] as const).map(([id, label]) => (
            <button
              key={id}
              title={id === 'list' ? 'Manage schedules & their run history' : 'See when everything fires — month, week, or day'}
              onClick={() => setMode(id)}
              style={{
                border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                background: mode === id ? 'var(--panel2)' : 'transparent',
                color: mode === id ? 'var(--accent)' : 'var(--mut)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
          {mode === 'calendar' ? 'Every firing on a month, week, or day grid — one-time and recurring' : 'One-time or recurring runs — expand a schedule for its run history'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setDialogOpen(true)}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New schedule
        </button>
      </ViewHeader>
      {mode === 'calendar' ? <ScheduleCalendar crons={s.crons} /> : (
      <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {s.crons.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 12.5 }}>
            No schedules yet — create one, or ask Master to (“build a nightly test job”).
          </div>
        )}
        {s.crons.map(c => {
          const open = openId === c.id
          const runCount = (c.runs ?? []).length
          return (
            <div key={c.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12 }}>
              <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16 }}>
                <Switch on={c.on} onToggle={() => toggleCron(c.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                    {c.built && (
                      <span style={{
                        display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
                        color: 'var(--accent)', background: hexToRgba(ACCENT, 0.14), borderRadius: 5, padding: '2px 7px',
                      }}>
                        <Icon paths={IC.bolt} size={10} stroke={2} />built by Master
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, fontSize: 11.5, color: 'var(--mut)' }}>
                    <span className="mono" style={{ color: 'var(--dim)' }}>
                      {c.at ? new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : c.schedule}
                    </span>
                    <span>{c.at ? (c.on ? 'one-time' : 'one-time · done') : describeCron(c.schedule).ok ? describeCron(c.schedule).text : c.human}</span>
                    <span style={{ color: 'var(--faint)' }}>·</span>
                    <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.boardTask
                      ? `adds board task · “${c.boardTask.title.slice(0, 40)}”${c.boardTask.startNow ? ' · starts immediately' : ' · to backlog'}`
                      : c.templateId
                      ? `template · ${(s.templates ?? []).find(t => t.id === c.templateId)?.name ?? c.templateId}${c.prompt ? ` — “${c.prompt.slice(0, 40)}”` : ''}`
                      : c.cmd ? c.cmd : 'no command — logs only'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color }} />
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>{c.agent}</span>
                </div>
                <div className="mono" style={{ width: 110, textAlign: 'right', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{c.last}</div>
                <button
                  className="icon-btn"
                  title={open ? 'Hide run history' : `Run history${runCount ? ` · ${runCount}` : ''}`}
                  style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0, color: open ? 'var(--accent)' : undefined }}
                  onClick={() => setOpenId(open ? null : c.id)}
                >
                  <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s', fontSize: 11 }}>▸</span>
                </button>
                <button className="icon-btn danger" title="Delete schedule" style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0 }} onClick={() => { void confirmAction({ title: `Delete schedule “${c.name.slice(0, 40)}”?`, detail: 'The schedule stops firing and cannot be recovered.' }).then(ok => { if (ok) deleteCron(c.id) }) }}>
                  <Icon paths={IC.close} size={13} stroke={1.8} />
                </button>
              </div>
              {open && <RunHistory cron={c} />}
            </div>
          )
        })}
      </div>
      )}
      {dialogOpen && <NewScheduleDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
