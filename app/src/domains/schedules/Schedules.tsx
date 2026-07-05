import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual, humanizeCron } from '../../store'
import { ACCENT, hexToRgba } from '../../core/data'
import type { Cron } from '../../core/types'
import { IC, Icon, Switch, ViewHeader } from '../../components/ui'
import { TaskSpecFields, emptyTaskSpec, useTaskSpecAssist } from '../board/TaskSpecForm'
import { confirmAction } from '../../components/Confirm'

/** default for the one-time picker: next full hour, in datetime-local format */
/** Return the next local clock hour in datetime-local input format. */
function nextHourLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  // Pad date fields to the width required by datetime-local inputs.
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Collect and normalize recurring or one-time schedule configuration. */
function NewScheduleDialog({ onClose }: { onClose: () => void }) {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { addCron } = useActions()
  const [kind, setKind] = useState<'cron' | 'once'>('cron')
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 3 * * *')
  const [at, setAt] = useState(nextHourLocal())
  const [action, setAction] = useState<'command' | 'task'>('command')
  const [cmd, setCmd] = useState('')
  const [cwd, setCwd] = useState('')
  // the task action uses the exact same spec form + AI gate as the board's
  // New-task dialog — templates are picked there as "Run with"
  const [spec, setSpec] = useState(() => emptyTaskSpec(s.settings.defaultCwd || ''))
  const [startNow, setStartNow] = useState(true)
  const { busy, questions, error, llmOn, draft, resolveForCreate } = useTaskSpecAssist(spec, setSpec)

  const atMs = kind === 'once' ? new Date(at).getTime() : 0
  const valid = Boolean(name.trim())
    && (kind === 'cron' ? schedule.trim().split(/\s+/).length === 5 : Number.isFinite(atMs) && atMs > Date.now())
    && (action !== 'task' || Boolean(spec.title.trim()))

  // Validate the selected mode and persist its normalized Cron record.
  const create = async () => {
    if (!valid || busy) return
    let boardTask: Cron['boardTask']
    if (action === 'task') {
      // same LLM completion / reject-with-questions gate as the task tab
      const patch = await resolveForCreate()
      if (!patch) return
      boardTask = { ...patch, startNow }
    }
    const once = kind === 'once'
    addCron({
      name: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      schedule: once ? '' : schedule.trim(),
      human: once
        ? `once · ${new Date(atMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
        : humanizeCron(schedule),
      at: once ? atMs : undefined,
      target: cwd.trim() ? cwd.trim().split('/').pop() || cwd.trim() : 'workspace',
      agent: action === 'task' ? 'Board' : cmd.trim() ? cmd.trim().split(/\s+/)[0] : 'Master',
      color: ACCENT,
      cmd: action === 'command' ? cmd.trim() || undefined : undefined,
      cwd: action === 'command' ? cwd.trim() || undefined : undefined,
      boardTask,
    })
    onClose()
  }

  const fieldStyle = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
    padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
    fontFamily: 'var(--font-mono)',
  } as const

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '16vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 540, maxWidth: '92vw', maxHeight: '84vh', overflowY: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New schedule</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          Run once at a future time, or recur on a cron expression. With a command set, each run launches a live session.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9, padding: 4 }}>
            {([['cron', 'Recurring · crontab'], ['once', 'One-time · run at']] as const).map(([k, label]) => (
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
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="name · e.g. nightly-regression" style={fieldStyle} />
          {kind === 'cron' ? (
            <div>
              <input value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="cron · min hour dom mon dow" style={fieldStyle} />
              <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4, paddingLeft: 2 }}>{humanizeCron(schedule)}</div>
            </div>
          ) : (
            <div>
              <input type="datetime-local" value={at} onChange={e => setAt(e.target.value)} style={fieldStyle} />
              <div style={{ fontSize: 11, color: Number.isFinite(atMs) && atMs > Date.now() ? 'var(--dim)' : 'var(--red-soft)', marginTop: 4, paddingLeft: 2 }}>
                {Number.isFinite(atMs) && atMs > Date.now()
                  ? `fires once · ${new Date(atMs).toLocaleString()}`
                  : 'pick a time in the future'}
              </div>
            </div>
          )}
          <select value={action} onChange={e => setAction(e.target.value as 'command' | 'task')} className="select-field" style={fieldStyle}>
            <option value="command">action · run a command</option>
            <option value="task">action · add a task to the board (template via “Run with”)</option>
          </select>
          {action === 'command' && (
            <>
              <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="command (optional) · e.g. claude -p 'run the tests'" style={fieldStyle} />
              <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working directory (optional)" style={fieldStyle} />
            </>
          )}
          {action === 'task' && (
            <>
              <TaskSpecFields v={spec} set={setSpec} questions={questions} error={error} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 2px 0' }}>
                <div style={{ flex: 1, fontSize: 11.5, color: 'var(--mut)' }}>
                  Start when it fires <span style={{ color: 'var(--dim)' }}>— the watcher spawns its one-shot immediately; off = lands in Backlog</span>
                </div>
                <Switch on={startNow} onToggle={() => setStartNow(v => !v)} />
              </div>
              {llmOn && (
                <button className="open-btn" style={{ alignSelf: 'flex-start', padding: '7px 14px', fontSize: 11.5, opacity: spec.title.trim() && !busy ? 1 : 0.45 }} onClick={draft} disabled={!spec.title.trim() || !!busy}>
                  {busy === 'draft' ? 'Drafting…' : '✦ Draft with AI'}
                </button>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: valid && !busy ? 1 : 0.45 }} onClick={create} disabled={!valid || !!busy}>
            {busy === 'create' ? 'Checking…' : 'Create schedule'}
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** List, toggle, remove, and create schedules for the active workspace. */
export function Schedules() {
  const s = useConductorSelector(x => ({ crons: x.crons, templates: x.templates }), shallowEqual)
  const { toggleCron, deleteCron } = useActions()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Schedules">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>One-time or recurring runs — schedules with a command launch live sessions</span>
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
        {s.crons.map(c => (
          <div key={c.id} style={{
            background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12,
            padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 16,
          }}>
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
                <span>{c.at ? (c.on ? 'one-time' : 'one-time · done') : c.human}</span>
                <span style={{ color: 'var(--faint)' }}>·</span>
                <span>{c.boardTask
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
            <div className="mono" style={{ width: 120, textAlign: 'right', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{c.last}</div>
            <button className="icon-btn danger" title="Delete schedule" style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0 }} onClick={() => { void confirmAction({ title: `Delete schedule “${c.name.slice(0, 40)}”?`, detail: 'The schedule stops firing and cannot be recovered.' }).then(ok => { if (ok) deleteCron(c.id) }) }}>
              <Icon paths={IC.close} size={13} stroke={1.8} />
            </button>
          </div>
        ))}
      </div>
      {dialogOpen && <NewScheduleDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
