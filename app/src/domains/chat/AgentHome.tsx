// A durable agent's home page — the default view when you open the agent:
// a dashboard the AGENT maintains (update_dashboard), its self-built mini
// apps (save_app, sandboxed like chat artifacts), its loops/schedules, and
// recent conversations. The profile dialog stays the place to edit identity.
import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import type { AgentApp, DurableAgent } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { confirmAction } from '../../components/Confirm'
import { artifactSrcDoc } from './artifacts'
import { AgentSchedules } from './DurableAgentDialog'
import { homeConversations } from './agent-home-state'

const CARD = {
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13,
} as const

function ago(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function SectionHead({ label, hint }: { label: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
      <span className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'var(--dim)' }}>{label}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>{hint}</span>}
    </div>
  )
}

/** Full-size sandboxed viewer for one mini app (same trust model as chat
 *  artifacts: opaque origin, inline-only CSP, no network). */
function AppViewer({ app, onClose }: { app: AgentApp; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.6)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 4vw' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', height: '100%', maxWidth: 1100, background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 26px 70px rgba(0,0,0,.6)' }}>
        <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{app.name}</span>
          {app.description && <span style={{ fontSize: 11, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.description}</span>}
          <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', marginLeft: 'auto', flexShrink: 0 }}>sandboxed · no network · updated {ago(app.updatedAt)}</span>
          <button className="icon-btn" title="Close" style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0 }} onClick={onClose}>
            <Icon paths={IC.close} size={13} stroke={1.8} />
          </button>
        </div>
        <iframe title={app.name} sandbox="allow-scripts" srcDoc={artifactSrcDoc({ kind: 'html', source: app.html })} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
      </div>
    </div>
  )
}

export function AgentHome({ agent, onEditProfile, onNewConversation, onOpenChat }: {
  agent: DurableAgent
  onEditProfile: () => void
  onNewConversation: () => void
  onOpenChat: (chatId: string) => void
}) {
  const s = useConductorSelector(x => ({ agents: x.agents, crons: x.crons, tasks: x.tasks, activeWorkspace: x.activeWorkspace }), shallowEqual)
  const { updateDurableAgent, archiveTask } = useActions()
  const [openApp, setOpenApp] = useState<AgentApp | null>(null)
  const conversations = homeConversations(s.agents, agent.id, s.activeWorkspace)
  const loops = s.crons.filter(c => c.durableAgentId === agent.id)
  const apps = agent.apps ?? []
  const requests = s.tasks.filter(t => t.requestedBy === agent.id && !t.archived && t.col !== 'done')

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '26px 28px 40px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* identity header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 46, height: 46, borderRadius: 13, background: agent.color, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0B0C10', fontWeight: 700, fontSize: 18 }}>
            {agent.name.slice(0, 2).toUpperCase()}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="grotesk" style={{ fontSize: 18, fontWeight: 600 }}>{agent.name}</div>
            <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agent.role || (agent.builtin ? 'the built-in generic agent' : 'durable agent')}
              {agent.homeDir ? <span className="mono" style={{ color: 'var(--faint)' }}> · {agent.homeDir}</span> : null}
            </div>
          </div>
          <button className="open-btn" style={{ flex: 'none', padding: '7px 14px', fontSize: 12 }} onClick={onEditProfile}>
            Edit profile
          </button>
          <button className="approve-btn" style={{ flex: 'none', padding: '7px 16px', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }} onClick={onNewConversation}>
            <Icon paths={IC.plus} size={13} stroke={2} />New conversation
          </button>
        </div>

        {/* the agent-maintained dashboard */}
        <div>
          <SectionHead label="DASHBOARD" hint={agent.dashboard?.trim() ? `maintained by ${agent.name} · updated ${ago(agent.dashboardAt ?? 0)}` : `maintained by ${agent.name} (update_dashboard)`} />
          <div style={{ ...CARD, padding: agent.dashboard?.trim() ? '6px 20px 14px' : 22 }}>
            {agent.dashboard?.trim() ? (
              <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text2)' }}>
                <Markdown text={agent.dashboard} />
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.6 }}>
                No dashboard yet. {agent.name} builds and maintains this page itself — start a conversation and ask it to
                set up its dashboard (it uses the <span className="mono">update_dashboard</span> tool and refreshes it as its work evolves).
              </div>
            )}
          </div>
        </div>

        {/* capability requests the agent filed and is waiting on */}
        {requests.length > 0 && (
          <div>
            <SectionHead label={`WAITING ON YOU · ${requests.length}`} hint="capabilities this agent asked for (request_capability)" />
            <div style={{ ...CARD, border: '1px solid rgba(245,196,81,.35)', padding: '4px 8px' }}>
              {requests.map((t, i) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px', borderBottom: i < requests.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>⚠</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                    {t.description && (
                      <div style={{ fontSize: 11, color: 'var(--mut)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {t.description.split('\n').find(l => l.startsWith('Why: '))?.slice(5) ?? t.description.replace(/\s+/g, ' ').slice(0, 120)}
                      </div>
                    )}
                  </div>
                  <button
                    className="open-btn"
                    title="Clear this request (grant the capability in Settings first if you intend to — then tell the agent it's available)"
                    style={{ padding: '4px 12px', fontSize: 11, flexShrink: 0 }}
                    onClick={() => archiveTask(t.id)}
                  >
                    Resolve
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* self-built mini apps */}
        <div>
          <SectionHead label={`MINI APPS · ${apps.length}`} hint="tools the agent built for itself (save_app) — sandboxed, no network" />
          {apps.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              {apps.map(app => (
                <div key={app.id} className="palette-item" onClick={() => setOpenApp(app)} style={{ ...CARD, padding: '12px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 3, background: agent.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{app.name}</span>
                    <button
                      className="icon-btn danger"
                      title="Delete this mini app"
                      style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0 }}
                      onClick={e => {
                        e.stopPropagation()
                        void confirmAction({ title: `Delete mini app “${app.name.slice(0, 40)}”?`, detail: 'The agent can rebuild it with save_app, but this version is gone.' })
                          .then(ok => { if (ok) updateDurableAgent(agent.id, { apps: (agent.apps ?? []).filter(a => a.id !== app.id) }) })
                      }}
                    >
                      <Icon paths={IC.close} size={9} stroke={2} />
                    </button>
                  </div>
                  <span style={{ fontSize: 10.5, color: 'var(--mut)', lineHeight: 1.45, minHeight: 15 }}>{app.description || 'no description'}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)' }}>updated {ago(app.updatedAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ ...CARD, padding: 18, fontSize: 12, color: 'var(--dim)', lineHeight: 1.6 }}>
              None yet. Ask {agent.name} to build one — a tracker, calculator, or visualization for its domain.
              It writes a self-contained HTML tool with <span className="mono">save_app</span>, and the app appears here.
            </div>
          )}
        </div>

        {/* loops & schedules */}
        <div>
          <SectionHead label={`LOOPS & SCHEDULES · ${loops.length}`} hint="recurring prompts and jobs that wake this agent" />
          <div style={{ ...CARD, padding: '14px 16px' }}>
            <AgentSchedules agentId={agent.id} />
          </div>
        </div>

        {/* recent conversations */}
        <div>
          <SectionHead label={`CONVERSATIONS · ${conversations.length}`} />
          <div style={{ ...CARD, padding: '6px 8px' }}>
            {conversations.slice(0, 8).map(c => {
              const last = (c.chatLog ?? []).filter(m => m.role === 'user' || m.role === 'assistant').at(-1)
              return (
                <button
                  key={c.id}
                  className="palette-item"
                  onClick={() => onOpenChat(c.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, border: 'none', background: 'transparent', textAlign: 'left' }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--mut)', minWidth: 0, maxWidth: '50%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{last?.text.replace(/\s+/g, ' ').slice(0, 70)}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{last ? ago(last.at) : ''}</span>
                </button>
              )
            })}
            {!conversations.length && (
              <div style={{ padding: '10px 10px 12px', fontSize: 12, color: 'var(--dim)' }}>No conversations yet.</div>
            )}
          </div>
        </div>

      </div>
      {openApp && <AppViewer app={openApp} onClose={() => setOpenApp(null)} />}
    </div>
  )
}
