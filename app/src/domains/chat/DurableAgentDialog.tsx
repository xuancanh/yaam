import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { isTauri, pickFolder } from '../../core/native'
import { EditableName, IC, Icon, Switch } from '../../components/ui'
import { DialogField, DialogFooter, DialogGrid, DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { buildCron, describeCron } from '../schedules/cron'
import { confirmAction } from '../../components/Confirm'

// The durable-agent profile: identity + charter (the stable job description),
// home folder (where its LESSONS.md / JOURNAL.md / knowledge live), defaults
// for new conversations, and its loops — schedules that send it a prompt on a
// cadence. "Reflect now" distills the latest conversation into its brain.

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9,
  padding: '8px 11px', color: 'var(--text)', outline: 'none', fontSize: 12.5,
  fontFamily: 'var(--font-sans)',
} as const

const AGENT_COLORS = ['#7FD1FF', '#B78AF7', '#3DDC97', '#FFB020', '#FF8FA3', '#F5C451', '#6FA8FF', '#E5636F']

/** One agent's recurring loops: prompt + cadence over the shared cron system. */
function AgentSchedules({ agentId }: { agentId: string }) {
  const crons = useConductorSelector(x => x.crons)
  const { addCron, toggleCron, deleteCron } = useActions()
  const mine = crons.filter(c => c.durableAgentId === agentId)
  const [prompt, setPrompt] = useState('')
  const [freq, setFreq] = useState<'daily' | 'hourly' | 'weekly'>('daily')
  const [time, setTime] = useState('09:00')
  const [dow, setDow] = useState(1)
  const schedule = buildCron({ freq, every: 10, time, dow, dom: 1 })

  const add = () => {
    if (!prompt.trim()) return
    addCron({
      name: prompt.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'agent-loop',
      schedule, human: describeCron(schedule).text,
      target: 'agent', agent: 'Chat', color: '#B78AF7',
      durableAgentId: agentId, agentPrompt: prompt.trim(),
    })
    setPrompt('')
  }

  return (
    <DialogField label="LOOPS" hint="recurring prompts sent to this agent's scheduled conversation">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {mine.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 9, padding: '7px 10px' }}>
            <Switch on={c.on} onToggle={() => toggleCron(c.id)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.agentPrompt}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{describeCron(c.schedule).text} · last: {c.last}</div>
            </div>
            <button className="icon-btn danger" title="Delete loop" style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0 }} onClick={() => deleteCron(c.id)}>
              <Icon paths={IC.close} size={10} stroke={2} />
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="e.g. Review the board and write a standup summary" style={{ ...FIELD, flex: 1, minWidth: 200 }} />
          <select value={freq} onChange={e => setFreq(e.target.value as typeof freq)} className="select-field" style={{ ...FIELD, width: 'auto' }}>
            <option value="daily">daily</option>
            <option value="hourly">hourly</option>
            <option value="weekly">weekly</option>
          </select>
          {freq === 'weekly' && (
            <select value={dow} onChange={e => setDow(Number(e.target.value))} className="select-field" style={{ ...FIELD, width: 'auto' }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          )}
          {freq !== 'hourly' && <input type="time" value={time} onChange={e => setTime(e.target.value || '09:00')} style={{ ...FIELD, width: 'auto', colorScheme: 'dark' }} />}
          <button className="open-btn" style={{ flexShrink: 0, padding: '7px 14px', fontSize: 11.5, opacity: prompt.trim() ? 1 : 0.5 }} disabled={!prompt.trim()} onClick={add}>
            Add loop
          </button>
        </div>
      </div>
    </DialogField>
  )
}

export function DurableAgentDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const s = useConductorSelector(x => ({ durableAgents: x.durableAgents, chatAgentTypes: x.chatAgentTypes }), shallowEqual)
  const { updateDurableAgent, archiveDurableAgent, reflectDurableAgent } = useActions()
  const agent = (s.durableAgents ?? []).find(d => d.id === agentId)
  const [reflectNote, setReflectNote] = useState<string | null>(null)
  const [reflecting, setReflecting] = useState(false)
  if (!agent) return null
  const upd = (patch: Parameters<typeof updateDurableAgent>[1]) => updateDurableAgent(agent.id, patch)

  const reflect = async () => {
    setReflecting(true)
    setReflectNote(null)
    try {
      setReflectNote(await reflectDurableAgent(agent.id))
    } catch (e) {
      setReflectNote(e instanceof Error ? e.message : String(e))
    } finally {
      setReflecting(false)
    }
  }

  return (
    <EntityDialog onClose={onClose} width={700}>
      <DialogHeader
        onClose={onClose}
        lead={<span style={{ width: 34, height: 34, borderRadius: 10, background: agent.color, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0B0C10', fontWeight: 700, fontSize: 14 }}>{agent.name.slice(0, 2).toUpperCase()}</span>}
        title={<EditableName name={agent.name} onRename={name => upd({ name })} fontSize={15} />}
        sub={<>
          {agent.builtin ? 'built-in generic agent · always available' : agent.homeDir ? `brain: ${agent.homeDir} (LESSONS.md · JOURNAL.md · knowledge/)` : 'no home folder — lessons go to the shared workspace memory'}
        </>}
        actions={
          <button className="open-btn" title="Distill the latest conversation into this agent's journal & lessons" style={{ flex: 'none', padding: '6px 13px', fontSize: 11.5 }} disabled={reflecting} onClick={() => { void reflect() }}>
            {reflecting ? 'Reflecting…' : '✦ Reflect now'}
          </button>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <DialogGrid>
          <DialogField label="ROLE" hint="one line, shown in the sidebar">
            <input value={agent.role ?? ''} onChange={e => upd({ role: e.target.value || undefined })} placeholder="e.g. project manager for loom" style={FIELD} />
          </DialogField>
          <DialogField label="COLOR">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', height: 34 }}>
              {AGENT_COLORS.map(c => (
                <button key={c} title={c} onClick={() => upd({ color: c })} style={{
                  width: 22, height: 22, borderRadius: 7, background: c, cursor: 'pointer',
                  border: agent.color === c ? '2px solid var(--text)' : '2px solid transparent',
                }} />
              ))}
            </div>
          </DialogField>
        </DialogGrid>

        {!agent.builtin && (
          <DialogField label="HOME FOLDER" hint="working dir + brain files; conversations start here">
            <div style={{ display: 'flex', gap: 6 }}>
              <input value={agent.homeDir ?? ''} onChange={e => upd({ homeDir: e.target.value || undefined })} placeholder="~/YaamAgents/chef" style={{ ...FIELD, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
              <button className="open-btn" style={{ flexShrink: 0, padding: '0 12px', fontSize: 11.5 }} disabled={!isTauri} onClick={() => { void pickFolder(agent.homeDir || undefined).then(dir => { if (dir) upd({ homeDir: dir }) }) }}>…</button>
            </div>
          </DialogField>
        )}

        <DialogField label="CHARTER" hint="the stable job description — scope, standards, rules; lessons build on top of it">
          <textarea
            value={agent.charter}
            onChange={e => upd({ charter: e.target.value })}
            placeholder="What is this agent's job? What does good work look like? What must it never do?"
            rows={5}
            style={{ ...FIELD, resize: 'vertical', lineHeight: 1.55 }}
          />
        </DialogField>

        <DialogGrid>
          <DialogField label="CHAT AGENT TYPE" hint="provider defaults for new conversations">
            <select value={agent.chatTypeId ?? ''} onChange={e => upd({ chatTypeId: e.target.value || undefined })} className="select-field" style={FIELD}>
              <option value="">default (first enabled)</option>
              {s.chatAgentTypes.filter(t => t.enabled).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </DialogField>
          <DialogField label="MODEL" hint="overrides the type's default">
            <input value={agent.model ?? ''} onChange={e => upd({ model: e.target.value || undefined })} placeholder="type default" style={{ ...FIELD, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
          </DialogField>
        </DialogGrid>

        <AgentSchedules agentId={agent.id} />

        {reflectNote && <div className="mono" style={{ fontSize: 11, color: 'var(--accent)' }}>✦ {reflectNote}</div>}
      </div>

      <DialogFooter onClose={onClose}>
        {!agent.builtin && (
          <button
            className="deny-btn"
            style={{ flex: 'none', padding: '8px 16px', color: 'var(--red-soft)', borderColor: 'rgba(255,92,92,.4)' }}
            onClick={() => {
              void confirmAction({
                title: `Archive agent “${agent.name.slice(0, 40)}”?`,
                detail: 'Its conversations stay; its loops stop firing. The brain files in its home folder are untouched.',
                confirmLabel: 'Archive', danger: false,
              }).then(ok => { if (ok) { archiveDurableAgent(agent.id); onClose() } })
            }}
          >
            Archive agent
          </button>
        )}
      </DialogFooter>
    </EntityDialog>
  )
}
