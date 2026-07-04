import { useState } from 'react'
import { useActions, useConductor, humanizeCron } from '../store'
import { ACCENT, hexToRgba } from '../data'
import { IC, Icon, Switch, ViewHeader } from './ui'

function NewScheduleDialog({ onClose }: { onClose: () => void }) {
  const s = useConductor()
  const { addCron } = useActions()
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('0 3 * * *')
  const [templateId, setTemplateId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [cmd, setCmd] = useState('')
  const [cwd, setCwd] = useState('')
  const templates = s.templates ?? []
  const tpl = templates.find(t => t.id === templateId)

  const valid = Boolean(name.trim()) && schedule.trim().split(/\s+/).length === 5

  const create = () => {
    if (!valid) return
    addCron({
      name: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      schedule: schedule.trim(),
      human: humanizeCron(schedule),
      target: cwd.trim() ? cwd.trim().split('/').pop() || cwd.trim() : 'workspace',
      agent: tpl ? tpl.name : cmd.trim() ? cmd.trim().split(/\s+/)[0] : 'Master',
      color: ACCENT,
      cmd: tpl ? undefined : cmd.trim() || undefined,
      cwd: tpl ? undefined : cwd.trim() || undefined,
      templateId: tpl?.id,
      prompt: tpl ? prompt.trim() || undefined : undefined,
    })
    onClose()
  }

  const fieldStyle = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
    padding: '9px 12px', color: 'var(--text)', outline: 'none', fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
  } as const

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '16vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: 480, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', padding: 18 }}
      >
        <div className="grotesk" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>New schedule</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginBottom: 14, lineHeight: 1.5 }}>
          Fires on a cron expression. With a command set, each run launches a live session.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="name · e.g. nightly-regression" style={fieldStyle} />
          <div>
            <input value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="cron · min hour dom mon dow" style={fieldStyle} />
            <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4, paddingLeft: 2 }}>{humanizeCron(schedule)}</div>
          </div>
          <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="select-field" style={fieldStyle}>
            <option value="">no template — raw command below</option>
            {templates.map(t => <option key={t.id} value={t.id}>template · {t.name} ({t.mode})</option>)}
          </select>
          {tpl ? (
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={tpl.prompt.includes('{task}') ? 'task text · fills {task} in the template prompt' : 'appended to the template prompt (optional)'}
              rows={3}
              style={{ ...fieldStyle, resize: 'vertical' }}
            />
          ) : (
            <>
              <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="command (optional) · e.g. claude -p 'run the tests'" style={fieldStyle} />
              <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working directory (optional)" style={fieldStyle} />
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="approve-btn" style={{ flex: 1, padding: 9, opacity: valid ? 1 : 0.45 }} onClick={create} disabled={!valid}>
            Create schedule
          </button>
          <button className="deny-btn" style={{ flex: 1, padding: 9 }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function Schedules() {
  const s = useConductor()
  const { toggleCron, deleteCron } = useActions()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Schedules">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Recurring runs — schedules with a command launch live sessions</span>
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
                <span className="mono" style={{ color: 'var(--dim)' }}>{c.schedule}</span>
                <span>{c.human}</span>
                <span style={{ color: 'var(--faint)' }}>·</span>
                <span>{c.templateId
                  ? `template · ${(s.templates ?? []).find(t => t.id === c.templateId)?.name ?? c.templateId}${c.prompt ? ` — “${c.prompt.slice(0, 40)}”` : ''}`
                  : c.cmd ? c.cmd : 'no command — logs only'}</span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color }} />
              <span style={{ fontSize: 12, color: '#C7CCD6' }}>{c.agent}</span>
            </div>
            <div className="mono" style={{ width: 120, textAlign: 'right', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{c.last}</div>
            <button className="icon-btn danger" title="Delete schedule" style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0 }} onClick={() => deleteCron(c.id)}>
              <Icon paths={IC.close} size={13} stroke={1.8} />
            </button>
          </div>
        ))}
      </div>
      {dialogOpen && <NewScheduleDialog onClose={() => setDialogOpen(false)} />}
    </div>
  )
}
