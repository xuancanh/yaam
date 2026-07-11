import { useEffect, useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { isTauri, pickFolder, readTextFile } from '../../core/native'
import { DialogHeader, EntityDialog } from '../../components/EntityDialog'
import { describeCron } from '../schedules/cron'
import { DURABLE_AGENT_TEMPLATES, parseAgentExport } from './agent-templates'
import type { AgentExport } from './agent-templates'
import { agentProfileInstallDetail, fetchAgentMarket, fetchAgentProfile } from './agent-market'
import type { MarketAgentEntry } from './agent-market'
import { mkId } from '../../shared/id'
import { confirmAction } from '../../components/Confirm'

// "Hire an agent": pick a role template (charter + starter loops scaffolded),
// install one from an agent marketplace (any configured registry whose
// index.json carries an `agents` array), or import an existing agent from a
// folder carrying AGENT.json — the folder itself is the agent's brain.

export function HireAgentDialog({ onClose, onHired }: { onClose: () => void; onHired: (agentId: string) => void }) {
  const s = useConductorSelector(x => ({ settings: x.settings }), shallowEqual)
  const { addDurableAgent, addCron } = useActions()
  const [err, setErr] = useState<string | null>(null)
  const [market, setMarket] = useState<MarketAgentEntry[] | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const registries = s.settings.registries
    ?? (s.settings.registryUrl ? [{ name: 'yaam', url: s.settings.registryUrl }] : [])
  useEffect(() => {
    let live = true
    void fetchAgentMarket(registries).then(a => { if (live) setMarket(a) })
    return () => { live = false }
  }, [registries.map(r => r.url).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Create the durable agent + its loops from one portable profile. */
  const adopt = (parsed: AgentExport, homeDir?: string): string => {
    const id = addDurableAgent({
      name: parsed.name, role: parsed.role, color: parsed.color, charter: parsed.charter, homeDir,
      dashboard: parsed.dashboard,
      dashboardAt: parsed.dashboard ? Date.now() : undefined,
      apps: parsed.apps?.map(a => ({ id: mkId('app'), name: a.name, description: a.description, html: a.html, updatedAt: Date.now() })),
    })
    for (const loop of parsed.loops ?? []) {
      addCron({
        name: loop.name, schedule: loop.schedule, human: describeCron(loop.schedule).text,
        target: 'agent', agent: 'Chat', color: parsed.color,
        durableAgentId: id, agentPrompt: loop.prompt,
      })
    }
    return id
  }

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

  const installFromMarket = async (entry: MarketAgentEntry) => {
    setErr(null)
    setInstalling(entry.url)
    try {
      const parsed = await fetchAgentProfile(entry)
      if (!parsed) {
        setErr(`“${entry.name}” from ${entry.registry} is not a valid agent profile.`)
        return
      }
      const approved = await confirmAction({
        title: `Hire “${parsed.name.slice(0, 40)}” from ${entry.registry}?`,
        detail: agentProfileInstallDetail(parsed),
        confirmLabel: 'Hire agent',
      })
      if (!approved) return
      onHired(adopt(parsed))
    } catch (e) {
      setErr(`could not install “${entry.name}”: ${e instanceof Error ? e.message : e}`)
    } finally {
      setInstalling(null)
    }
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
    onHired(adopt(parsed, dir))
  }

  return (
    <EntityDialog onClose={onClose} width={640}>
      <DialogHeader
        onClose={onClose}
        title={<span style={{ fontSize: 15, fontWeight: 600 }}>Hire a durable agent</span>}
        sub="A persistent identity that learns across conversations, maintains its own dashboard, and builds its own mini apps. Pick a role, install one from a marketplace, or import a folder."
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

      <div style={{ marginTop: 18 }}>
        <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)', marginBottom: 8 }}>
          MARKETPLACE {market ? `· ${market.length}` : ''}
          <span style={{ fontWeight: 400, letterSpacing: 0, marginLeft: 8, color: 'var(--faint)', textTransform: 'none' }}>
            from your registries (Settings → Addons) — profiles with charter, loops, dashboard & mini apps
          </span>
        </div>
        {market === null ? (
          <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '4px 0 2px' }}>loading registries…</div>
        ) : market.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '4px 0 2px' }}>
            No agents published in your registries yet — a registry lists them under <span className="mono">"agents"</span> in its index.json.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {market.map(entry => (
              <div key={`${entry.registry}:${entry.url}`} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 12px' }}>
                <span style={{ fontSize: 15, flexShrink: 0, width: 22, textAlign: 'center' }}>{entry.icon || '✦'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{entry.name}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', marginLeft: 7 }}>{entry.registry}</span>
                  <div style={{ fontSize: 10.5, color: 'var(--mut)', marginTop: 1, lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {entry.description || entry.role || ''}
                  </div>
                </div>
                <button
                  className="open-btn"
                  style={{ flexShrink: 0, padding: '6px 14px', fontSize: 11.5, opacity: installing ? 0.6 : 1 }}
                  disabled={!!installing}
                  onClick={() => { void installFromMarket(entry) }}
                >
                  {installing === entry.url ? 'Installing…' : 'Hire'}
                </button>
              </div>
            ))}
          </div>
        )}
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
