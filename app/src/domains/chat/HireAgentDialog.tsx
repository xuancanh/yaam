import { useState } from 'react'
import { useActions } from '../../store'
import { isTauri, pickFolder, readTextFile } from '../../core/native'
import { DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { describeCron } from '../schedules/cron'
import { DURABLE_AGENT_TEMPLATES, parseAgentExport } from './agent-templates'

// "Hire an agent": pick a role template (charter + starter loops scaffolded),
// or import an existing agent from a folder carrying AGENT.json — the folder
// itself is the agent's brain, so import = adopt the folder.

export function HireAgentDialog({ onClose, onHired }: { onClose: () => void; onHired: (agentId: string) => void }) {
  const { addDurableAgent, addCron } = useActions()
  const [err, setErr] = useState<string | null>(null)

  const hire = (templateId: string) => {
    const tpl = DURABLE_AGENT_TEMPLATES.find(t => t.id === templateId)
    if (!tpl) return
    const id = addDurableAgent({
      name: tpl.id === 'blank' ? 'New agent' : tpl.name,
      role: tpl.role || undefined,
      color: tpl.color,
      charter: tpl.charter,
    })
    for (const loop of tpl.loops ?? []) {
      addCron({
        name: loop.name, schedule: loop.schedule, human: describeCron(loop.schedule).text,
        target: 'agent', agent: 'Chat', color: tpl.color,
        durableAgentId: id, agentPrompt: loop.prompt,
      })
    }
    onHired(id)
  }

  const importFromFolder = async () => {
    setErr(null)
    const dir = await pickFolder()
    if (!dir) return
    const text = await readTextFile(`${dir.replace(/\/+$/, '')}/AGENT.json`).catch(() => null)
    const parsed = text ? parseAgentExport(text) : null
    if (!parsed) {
      setErr(`No readable AGENT.json in ${dir} — export an agent there first, or pick another folder.`)
      return
    }
    const id = addDurableAgent({
      name: parsed.name, role: parsed.role, color: parsed.color, charter: parsed.charter, homeDir: dir,
    })
    for (const loop of parsed.loops ?? []) {
      addCron({
        name: loop.name, schedule: loop.schedule, human: describeCron(loop.schedule).text,
        target: 'agent', agent: 'Chat', color: parsed.color,
        durableAgentId: id, agentPrompt: loop.prompt,
      })
    }
    onHired(id)
  }

  return (
    <EntityDialog onClose={onClose} width={640}>
      <DialogHeader
        onClose={onClose}
        title={<span style={{ fontSize: 15, fontWeight: 600 }}>Hire a durable agent</span>}
        sub="A persistent identity that learns across conversations. Pick a role to scaffold its charter and starter loops — then give it a home folder in its profile so it grows a brain."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {DURABLE_AGENT_TEMPLATES.map(tpl => (
          <button
            key={tpl.id}
            className="palette-item"
            onClick={() => hire(tpl.id)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 13px', borderRadius: 11,
              background: 'var(--panel)', border: '1px solid var(--line)', textAlign: 'left', cursor: 'pointer',
            }}
          >
            <span style={{
              width: 32, height: 32, borderRadius: 9, background: tpl.color, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
            }}>
              {tpl.icon}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{tpl.name}</span>
              <span style={{ display: 'block', fontSize: 10.5, color: 'var(--mut)', marginTop: 2, lineHeight: 1.45 }}>{tpl.blurb}</span>
              {!!tpl.loops?.length && (
                <span className="mono" style={{ display: 'block', fontSize: 9.5, color: 'var(--accent)', marginTop: 4 }}>
                  ⟳ {tpl.loops.map(l => l.name).join(' · ')}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--red-soft)', marginTop: 12, lineHeight: 1.5 }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
        <button className="open-btn" style={{ flex: 'none', padding: '8px 14px', fontSize: 12 }} disabled={!isTauri} onClick={() => { void importFromFolder() }}>
          Import from folder… <span style={{ color: 'var(--dim)' }}>(AGENT.json)</span>
        </button>
        <div style={{ flex: 1 }} />
        <button className="deny-btn" style={{ flex: 'none', padding: '8px 18px' }} onClick={onClose}>Cancel</button>
      </div>
    </EntityDialog>
  )
}
