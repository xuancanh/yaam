// A durable agent's home page — the default view when you open the agent,
// split into tabs: Dashboard (agent-maintained markdown + pending requests),
// Mini apps (self-built, embeddable into a conversation), Settings (profile
// summary + loops), Memory (the file brain: lessons + journal), Skills,
// Chats (full conversation history), and MCP (connected servers).
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import type { Agent, AgentApp, DurableAgent } from '../../core/types'
import { IC, Icon } from '../../components/ui'
import { Markdown } from '../../components/Markdown'
import { confirmAction } from '../../components/Confirm'
import { artifactSrcDoc } from './artifacts'
import { AgentSchedules } from './DurableAgentDialog'
import { homeConversations } from './agent-home-state'
import { loadBrain, type AgentBrain } from './durable-brain'
import { requestAppEmbed } from './attach-bus'

const CARD = {
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13,
  boxShadow: 'var(--shadow-card)',
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

function EmptyCard({ children }: { children: ReactNode }) {
  return <div style={{ ...CARD, padding: 18, fontSize: 12, color: 'var(--dim)', lineHeight: 1.6 }}>{children}</div>
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

/** One conversation row, shared by the dashboard snippet and the Chats tab. */
function ConversationRow({ c, botName, onOpen }: { c: Agent; botName: string; onOpen: () => void }) {
  const last = (c.chatLog ?? []).filter(m => m.role === 'user' || m.role === 'assistant').at(-1)
  return (
    <button
      className="palette-item"
      onClick={onOpen}
      title={botName}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, border: 'none', background: 'transparent', textAlign: 'left' }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
      <span style={{ fontSize: 10.5, color: 'var(--mut)', minWidth: 0, maxWidth: '50%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{last?.text.replace(/\s+/g, ' ').slice(0, 70)}</span>
      <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{last ? ago(last.at) : ''}</span>
    </button>
  )
}

const TABS = ['Dashboard', 'Mini apps', 'Settings', 'Memory', 'Skills', 'Chats', 'MCP'] as const
type HomeTab = (typeof TABS)[number]

export function AgentHome({ agent, onEditProfile, onNewConversation, onOpenChat }: {
  agent: DurableAgent
  onEditProfile: () => void
  onNewConversation: () => void
  onOpenChat: (chatId: string) => void
}) {
  const s = useConductorSelector(x => ({
    agents: x.agents, crons: x.crons, tasks: x.tasks, activeWorkspace: x.activeWorkspace,
    skills: x.skills, skillRegistries: x.skillRegistries, mcpServers: x.mcpServers, chatAgentTypes: x.chatAgentTypes,
  }), shallowEqual)
  const { updateDurableAgent, archiveTask } = useActions()
  const [tab, setTab] = useState<HomeTab>('Dashboard')
  const [openApp, setOpenApp] = useState<AgentApp | null>(null)
  const [brain, setBrain] = useState<AgentBrain | null>(null)
  const [chatQuery, setChatQuery] = useState('')
  const conversations = homeConversations(s.agents, agent.id, s.activeWorkspace)
  const loops = s.crons.filter(c => c.durableAgentId === agent.id)
  const apps = agent.apps ?? []
  const requests = s.tasks.filter(t => t.requestedBy === agent.id && !t.archived && t.col !== 'done')

  // the file brain is read lazily when the Memory tab opens (and on refresh)
  const refreshBrain = () => { void loadBrain(agent).then(setBrain).catch(() => setBrain({ lessons: '', journal: '' })) }
  useEffect(() => {
    if (tab === 'Memory' && brain === null) refreshBrain()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // send a mini app into the most recent conversation's artifact panel
  const embedApp = (app: AgentApp) => {
    const target = conversations[0]
    if (!target) { onNewConversation(); return }
    onOpenChat(target.id)
    // the pane may only mount after the view switches — retry once
    if (!requestAppEmbed(target.id, app)) window.setTimeout(() => requestAppEmbed(target.id, app), 250)
  }

  const skillSources = agent.skillSourceIds ?? ['local', ...s.skillRegistries.filter(r => r.enabled).map(r => r.id)]
  const chatType = s.chatAgentTypes.find(t => t.id === agent.chatTypeId)
  const filteredChats = useMemo(() => {
    const q = chatQuery.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(c => c.name.toLowerCase().includes(q)
      || (c.chatLog ?? []).some(m => (m.role === 'user' || m.role === 'assistant') && m.text.toLowerCase().includes(q)))
  }, [conversations, chatQuery])

  const counts: Partial<Record<HomeTab, number>> = {
    'Mini apps': apps.length, Chats: conversations.length,
    MCP: s.mcpServers.filter(m => m.enabled).length,
    ...(requests.length ? { Dashboard: requests.length } : {}),
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '26px 28px 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* identity header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 46, height: 46, borderRadius: 13, background: agent.color, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0B0C10', fontWeight: 700, fontSize: 18, boxShadow: 'var(--shadow-card)' }}>
            {agent.name.slice(0, 2).toUpperCase()}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="grotesk" style={{ fontSize: 18, fontWeight: 600 }}>{agent.name}</div>
            <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agent.role || (agent.builtin ? 'the built-in generic agent' : 'durable agent')}
              {agent.homeDir ? <span className="mono" style={{ color: 'var(--faint)' }}> · {agent.homeDir}</span> : null}
            </div>
          </div>
          <button className="approve-btn" style={{ flex: 'none', padding: '7px 16px', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }} onClick={onNewConversation}>
            <Icon paths={IC.plus} size={13} stroke={2} />New conversation
          </button>
        </div>

        {/* tab bar */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--line)', overflowX: 'auto' }}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '7px 13px 9px', fontSize: 12.5,
                fontWeight: tab === t ? 600 : 500, whiteSpace: 'nowrap',
                color: tab === t ? 'var(--text)' : 'var(--mut)',
                borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t}
              {counts[t] ? <span style={{ marginLeft: 6, fontSize: 10, color: t === 'Dashboard' ? 'var(--amber)' : 'var(--dim)' }}>{counts[t]}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'Dashboard' && (<>
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
          {conversations.length > 0 && (
            <div>
              <SectionHead label="RECENT CONVERSATIONS" />
              <div style={{ ...CARD, padding: '6px 8px' }}>
                {conversations.slice(0, 5).map(c => <ConversationRow key={c.id} c={c} botName={agent.name} onOpen={() => onOpenChat(c.id)} />)}
              </div>
            </div>
          )}
        </>)}

        {tab === 'Mini apps' && (
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flex: 1 }}>updated {ago(app.updatedAt)}</span>
                      <button
                        className="open-btn"
                        title="Open this app side-by-side inside the latest conversation"
                        style={{ padding: '3px 10px', fontSize: 10.5, flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); embedApp(app) }}
                      >
                        Embed in chat
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyCard>
                None yet. Ask {agent.name} to build one — a tracker, calculator, or visualization for its domain.
                It writes a self-contained HTML tool with <span className="mono">save_app</span>, and the app appears here.
              </EmptyCard>
            )}
          </div>
        )}

        {tab === 'Settings' && (<>
          <div>
            <SectionHead label="PROFILE" hint="identity and defaults — the agent can propose changes (update_my_profile), you approve them" />
            <div style={{ ...CARD, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                ['Role', agent.role || '—'],
                ['Home folder', agent.homeDir || '(none — no file brain)'],
                ['Default model', agent.model || chatType?.model || '(chat type default)'],
                ['Chat type', chatType?.name ?? '(first enabled)'],
                ['Skill sources', skillSources.join(', ') || '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
                  <span style={{ width: 110, flexShrink: 0, color: 'var(--dim)' }}>{k}</span>
                  <span className={k === 'Home folder' ? 'mono' : undefined} style={{ minWidth: 0, overflowWrap: 'anywhere', color: 'var(--text2)', fontSize: k === 'Home folder' ? 11.5 : 12.5 }}>{v}</span>
                </div>
              ))}
              <div>
                <button className="open-btn" style={{ padding: '6px 14px', fontSize: 12, marginTop: 4 }} onClick={onEditProfile}>Edit profile</button>
              </div>
            </div>
          </div>
          <div>
            <SectionHead label="CHARTER" hint="the job description — stable, user-owned" />
            <div style={{ ...CARD, padding: agent.charter.trim() ? '6px 18px 12px' : 18 }}>
              {agent.charter.trim()
                ? <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text2)' }}><Markdown text={agent.charter} /></div>
                : <span style={{ fontSize: 12, color: 'var(--dim)' }}>No charter yet — the agent will propose one once it understands its job.</span>}
            </div>
          </div>
          <div>
            <SectionHead label={`LOOPS & SCHEDULES · ${loops.length}`} hint="recurring prompts and jobs that wake this agent" />
            <div style={{ ...CARD, padding: '14px 16px' }}>
              <AgentSchedules agentId={agent.id} />
            </div>
          </div>
        </>)}

        {tab === 'Memory' && (
          agent.homeDir?.trim() ? (<>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="open-btn" style={{ padding: '4px 12px', fontSize: 11 }} onClick={refreshBrain}>Refresh</button>
            </div>
            <div>
              <SectionHead label="LESSONS" hint="corrections and learnings the agent maintains (learn_lesson, your 👎 notes) — consolidated weekly" />
              <div style={{ ...CARD, padding: brain?.lessons.trim() ? '6px 18px 12px' : 18, maxHeight: 420, overflowY: 'auto' }}>
                {brain === null ? <span style={{ fontSize: 12, color: 'var(--dim)' }}>loading…</span>
                  : brain.lessons.trim()
                    ? <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text2)' }}><Markdown text={brain.lessons} /></div>
                    : <span style={{ fontSize: 12, color: 'var(--dim)' }}>No lessons yet — they accumulate from your corrections and 👎 feedback.</span>}
              </div>
            </div>
            <div>
              <SectionHead label="JOURNAL" hint="episodic log distilled after conversations (reflection)" />
              <div style={{ ...CARD, padding: brain?.journal.trim() ? '6px 18px 12px' : 18, maxHeight: 420, overflowY: 'auto' }}>
                {brain === null ? <span style={{ fontSize: 12, color: 'var(--dim)' }}>loading…</span>
                  : brain.journal.trim()
                    ? <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--text2)' }}><Markdown text={brain.journal} /></div>
                    : <span style={{ fontSize: 12, color: 'var(--dim)' }}>No journal entries yet — the agent reflects after conversations.</span>}
              </div>
            </div>
            <span style={{ fontSize: 11, color: 'var(--faint)' }}>
              Files live in <span className="mono">{agent.homeDir!.replace(/\/+$/, '')}/LESSONS.md · JOURNAL.md · knowledge/</span> — edit them directly anytime; changes are git-committed when the folder is a repo.
            </span>
          </>) : (
            <EmptyCard>
              This agent has no home folder, so it has no file brain of its own. Its lessons land in the shared
              workspace memory (Settings → Memory). Give it a home folder in the profile to enable LESSONS.md, JOURNAL.md, and knowledge/.
            </EmptyCard>
          )
        )}

        {tab === 'Skills' && (
          <div>
            <SectionHead label="SKILLS" hint={`sources for this agent's conversations: ${skillSources.join(', ') || 'none'}`} />
            {skillSources.includes('local') && s.skills.length > 0 && (
              <div style={{ ...CARD, padding: '6px 8px', marginBottom: 10 }}>
                {s.skills.map(k => (
                  <div key={k.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 10px' }}>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>/{k.name}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--mut)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.description}</span>
                    <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', marginLeft: 'auto', flexShrink: 0 }}>local</span>
                  </div>
                ))}
              </div>
            )}
            {s.skillRegistries.filter(r => skillSources.includes(r.id)).map(r => (
              <div key={r.id} style={{ ...CARD, padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                <span style={{ fontSize: 11, color: r.lastError ? 'var(--red)' : 'var(--mut)' }}>
                  {r.lastError ? r.lastError.slice(0, 60) : `${r.skillCount ?? '?'} skills`}
                </span>
                <span className="mono" style={{ fontSize: 9.5, color: r.enabled ? 'var(--green)' : 'var(--dim)', flexShrink: 0 }}>{r.enabled ? 'on' : 'off'}</span>
              </div>
            ))}
            {!s.skills.length && !s.skillRegistries.some(r => skillSources.includes(r.id)) && (
              <EmptyCard>No skills available. Add local skills or a skill registry in Settings → Skills, and the agent loads them on demand (or via /slash commands).</EmptyCard>
            )}
          </div>
        )}

        {tab === 'Chats' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <SectionHead label={`CONVERSATIONS · ${conversations.length}`} />
              <input
                value={chatQuery}
                onChange={e => setChatQuery(e.target.value)}
                placeholder="search title or content…"
                style={{
                  marginLeft: 'auto', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 8,
                  color: 'var(--text)', fontSize: 11.5, padding: '5px 10px', outline: 'none', width: 220,
                }}
              />
            </div>
            <div style={{ ...CARD, padding: '6px 8px' }}>
              {filteredChats.map(c => <ConversationRow key={c.id} c={c} botName={agent.name} onOpen={() => onOpenChat(c.id)} />)}
              {!filteredChats.length && (
                <div style={{ padding: '10px 10px 12px', fontSize: 12, color: 'var(--dim)' }}>
                  {conversations.length ? 'No conversations match.' : 'No conversations yet.'}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'MCP' && (
          <div>
            <SectionHead label={`CONNECTED MCP SERVERS · ${s.mcpServers.filter(m => m.enabled).length}`} hint="every conversation of this agent can call tools on the enabled servers" />
            {s.mcpServers.length ? s.mcpServers.map(m => (
              <div key={m.id} style={{ ...CARD, padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.enabled ? (m.lastError ? 'var(--red)' : 'var(--green)') : 'var(--dim)', flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>{m.name}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}>{m.transport ?? 'http'}</span>
                <span style={{ fontSize: 11, color: m.lastError ? 'var(--red)' : 'var(--mut)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginLeft: 'auto' }}>
                  {m.lastError ? m.lastError.slice(0, 80) : m.enabled ? `${m.toolCount ?? 0} tools` : 'disabled'}
                </span>
              </div>
            )) : (
              <EmptyCard>No MCP servers configured. Add them in Settings → Integrations — their tools become available to every conversation, and the agent can request ones it needs (request_capability).</EmptyCard>
            )}
          </div>
        )}

      </div>
      {openApp && <AppViewer app={openApp} onClose={() => setOpenApp(null)} />}
    </div>
  )
}
