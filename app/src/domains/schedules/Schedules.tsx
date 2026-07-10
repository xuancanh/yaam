import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import type { Cron } from '../../core/types'
import { IC, Icon, Switch, ViewHeader } from '../../components/ui'
import { SpecVerifyDialog, TaskSpecFields, emptyTaskSpec, useTaskSpecAssist } from '../board/TaskSpecForm'
import type { TaskSpecPatch, VerifyOutcome } from '../board/TaskSpecForm'
import { buildCron, describeCron } from './cron'
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

/** List, toggle, remove, and create schedules for the active workspace. */
export function Schedules() {
  const s = useConductorSelector(x => ({ crons: x.crons, templates: x.templates }), shallowEqual)
  const { toggleCron, deleteCron } = useActions()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Schedules">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>One-time or recurring runs — expand a schedule for its run history</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setDialogOpen(true)}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New schedule
        </button>
      </ViewHeader>
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
      {dialogOpen && <NewScheduleDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
