import { useEffect, useState } from 'react'
import { useActions, useConductor } from '../store'
import { chatSearch, isTauri, pickFolder } from '../native'
import type { ChatSearchHit } from '../native'
import { ACCENT, hexToRgba } from '../data'
import type { Agent } from '../types'
import { EditableName, IC, Icon } from './ui'
import { ChatPane } from './workspace/ChatPane'

// ChatGPT/Claude-style chat home: a sidebar of conversations (full-text
// searchable via the embedded tantivy engine) and the selected conversation
// in the main area. Chat sessions live here — not in the workspace tabs.

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12,
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
} as const

/** last non-tool message of a chat, for the sidebar snippet */
function lastSnippet(a: Agent): { text: string; at: number } {
  const msgs = (a.chatLog ?? []).filter(m => m.role !== 'tool')
  const m = msgs[msgs.length - 1]
  return { text: m?.text.replace(/\s+/g, ' ').slice(0, 80) ?? '', at: m?.at ?? 0 }
}

function timeLabel(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** inline "new chat" composer: agent type, model, folder */
function NewChatRow({ onCreated }: { onCreated: (id: string) => void }) {
  const s = useConductor()
  const { newChatSession } = useActions()
  const types = s.chatAgentTypes.filter(t => t.enabled)
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')
  const [personaId, setPersonaId] = useState('')
  const [sources, setSources] = useState<string[]>(() => ['local', ...s.skillRegistries.filter(r => r.enabled).map(r => r.id)])
  const type = s.chatAgentTypes.find(t => t.id === typeId) ?? types[0]
  const toggleSource = (id: string) =>
    setSources(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))
  const models = ((type?.models ?? []).map(m => m.trim()).filter(Boolean))
  const list = models.length ? models : type?.model ? [type.model] : []
  const effModel = model && list.includes(model) ? model : list[0] ?? ''

  const browse = async () => {
    const dir = await pickFolder(cwd || undefined)
    if (dir) setCwd(dir)
  }

  if (!types.length) {
    return (
      <div style={{ padding: '10px 12px', fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.5 }}>
        No chat agents enabled — add one in Settings → Chat Agents.
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <select value={type?.id ?? ''} onChange={e => { setTypeId(e.target.value); setModel('') }} className="select-field" style={{ ...FIELD, flex: 1, minWidth: 0 }}>
          {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={effModel} onChange={e => setModel(e.target.value)} disabled={list.length <= 1} className="select-field" style={{ ...FIELD, flex: 1, minWidth: 0 }}>
          {list.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <select value={personaId} onChange={e => setPersonaId(e.target.value)} className="select-field" style={FIELD} title="Persona — appended to the agent's instructions">
        <option value="">no persona</option>
        {s.personas.map(pe => <option key={pe.id} value={pe.id}>{pe.name}{pe.description ? ` — ${pe.description.slice(0, 40)}` : ''}</option>)}
      </select>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }} title="Skill sources for this chat — the agent sees and loads skills from the checked sources">
        <span className="mono" style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: 0.4, color: 'var(--dim)' }}>SKILLS</span>
        {[{ id: 'local', name: 'local', count: s.skills.length }, ...s.skillRegistries.map(r => ({ id: r.id, name: r.name, count: r.skillCount }))].map(src => {
          const on = sources.includes(src.id)
          return (
            <button
              key={src.id}
              className="mono"
              onClick={() => toggleSource(src.id)}
              style={{
                fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(61,220,151,.35)' : 'var(--line2)'}`,
                background: on ? 'rgba(61,220,151,.1)' : 'transparent',
                color: on ? 'var(--green)' : 'var(--dim)',
              }}
            >
              {src.name}{src.count !== undefined ? ` · ${src.count}` : ''}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working folder (optional)" className="mono" style={{ ...FIELD, flex: 1, fontSize: 11 }} />
        <button className="open-btn" style={{ flex: 'none', padding: '0 10px', fontSize: 11.5 }} onClick={browse} disabled={!isTauri}>…</button>
      </div>
      <button
        className="approve-btn"
        style={{ padding: 7, fontSize: 12 }}
        onClick={() => { if (type) onCreated(newChatSession(undefined, cwd, type.id, effModel || undefined, personaId || undefined, sources)) }}
      >
        Start chat{type ? ` · ${type.name}` : ''}
      </button>
    </div>
  )
}

export function ChatView() {
  const s = useConductor()
  const { openChat, deleteSession, renameSession } = useActions()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSearchHit[] | null>(null)
  const [creating, setCreating] = useState(false)

  const chats = s.agents
    .filter(a => a.kind === 'chat' && !a.archived)
    .map(a => ({ agent: a, last: lastSnippet(a) }))
    .sort((x, y) => y.last.at - x.last.at)

  const selected = s.agents.find(a => a.id === s.activeChatId && a.kind === 'chat')

  // full-text search through the embedded engine (debounced)
  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits(null); return }
    const t = window.setTimeout(() => {
      chatSearch(q, 40)
        .then(setHits)
        .catch(() => setHits([]))
    }, 200)
    return () => window.clearTimeout(t)
  }, [query])

  // search results grouped by chat, best score first
  const searchGroups = (() => {
    if (!hits) return null
    const byChat = new Map<string, { agent: Agent; best: number; samples: ChatSearchHit[] }>()
    for (const h of hits) {
      const agent = s.agents.find(a => a.id === h.chatId && a.kind === 'chat' && !a.archived)
      if (!agent) continue
      const g = byChat.get(h.chatId) ?? { agent, best: 0, samples: [] }
      g.best = Math.max(g.best, h.score)
      if (g.samples.length < 2) g.samples.push(h)
      byChat.set(h.chatId, g)
    }
    return [...byChat.values()].sort((a, b) => b.best - a.best)
  })()

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px' }}>
          <span className="grotesk" style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>Chats</span>
          <button
            className="icon-btn"
            title="New chat"
            onClick={() => setCreating(v => !v)}
            style={{ width: 28, height: 28, borderRadius: 8, background: creating ? hexToRgba(ACCENT, 0.14) : 'transparent', color: creating ? 'var(--accent)' : undefined }}
          >
            <Icon paths={IC.plus} size={15} stroke={1.8} />
          </button>
        </div>
        {creating && <NewChatRow onCreated={id => { openChat(id); setCreating(false) }} />}
        <div style={{ padding: '4px 12px 8px' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search all chats… (full-text)"
            style={FIELD}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
          {searchGroups ? (
            searchGroups.length ? searchGroups.map(g => (
              <button
                key={g.agent.id}
                className="palette-item"
                onClick={() => openChat(g.agent.id)}
                style={{
                  width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 10px', borderRadius: 9,
                  background: s.activeChatId === g.agent.id ? 'rgba(245,196,81,.08)' : 'transparent',
                  border: 'none', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{g.agent.name}</span>
                {g.samples.map(h => (
                  <span key={h.msgId} style={{ fontSize: 10.5, color: 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>
                    {h.role === 'user' ? 'you: ' : ''}{h.text.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 90) || h.text.slice(0, 90)}
                  </span>
                ))}
              </button>
            )) : <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '6px 10px' }}>no matches</div>
          ) : chats.length ? chats.map(({ agent: a, last }) => (
            <div
              key={a.id}
              className="palette-item"
              onClick={() => openChat(a.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px', borderRadius: 9, cursor: 'pointer',
                background: s.activeChatId === a.id ? 'rgba(245,196,81,.08)' : 'transparent',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                    {a.name}
                  </span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{timeLabel(last.at)}</span>
                </div>
                <div style={{ fontSize: 10.5, color: a.status === 'running' ? 'var(--accent)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                  {a.status === 'running' ? 'thinking…' : last.text || 'empty chat'}
                </div>
              </div>
              <button
                className="icon-btn danger"
                title="Delete chat"
                style={{ width: 20, height: 20, borderRadius: 5, flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); deleteSession(a.id) }}
              >
                <Icon paths={IC.close} size={10} stroke={2} />
              </button>
            </div>
          )) : (
            <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '8px 10px', lineHeight: 1.6 }}>
              No chats yet — hit + to start one. Chat agents browse & edit files, run commands, load skills, and call MCP servers.
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#0A0B0F' }}>
        {selected ? (
          <>
            <div style={{
              height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
              background: 'var(--panel)', borderBottom: '1px solid var(--line)',
            }}>
              <EditableName name={selected.name} onRename={name => renameSession(selected.id, name)} fontSize={13.5} />
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>{selected.model}</span>
              {selected.cwd && <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected.cwd}</span>}
              <div style={{ flex: 1 }} />
              {selected.status === 'running' && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
                  thinking
                </span>
              )}
            </div>
            <ChatPane agent={selected} active />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{ fontSize: 30, opacity: 0.5 }}>💬</div>
            <div className="grotesk" style={{ fontSize: 16, fontWeight: 600, color: 'var(--mut)' }}>Pick a chat — or start one</div>
            <div style={{ fontSize: 12.5, color: 'var(--dim)', maxWidth: 380, textAlign: 'center', lineHeight: 1.6 }}>
              Chat agents work like a desktop Claude: they browse and edit files, run commands and scripts, load your skills,
              and call your MCP servers — streaming replies as they think.
            </div>
            <button className="approve-btn" style={{ padding: '9px 22px', fontSize: 13 }} onClick={() => setCreating(true)}>
              New chat
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
