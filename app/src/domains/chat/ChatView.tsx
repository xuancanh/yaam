import { useEffect, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { chatSearch, isTauri, pickFolder } from '../../core/native'
import type { ChatSearchHit } from '../../core/native'
import { ACCENT, hexToRgba } from '../../core/data'
import type { Agent } from '../../core/types'
import { EditableName, IC, Icon } from '../../components/ui'
import { ChatPane } from './ChatPane'
import { FilesPane } from '../session/FilesPane'
import { confirmAction } from '../../components/Confirm'

// ChatGPT/Claude-style chat home: a sidebar of conversations (full-text
// searchable via the embedded tantivy engine) and the selected conversation
// in the main area. Chat sessions live here — not in the workspace tabs.

const FIELD = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 8,
  padding: '7px 10px', color: 'var(--text)', outline: 'none', fontSize: 12,
  fontFamily: 'var(--font-sans)',
} as const

/** last non-tool message of a chat, for the sidebar snippet */
function lastSnippet(a: Agent): { text: string; at: number } {
  const msgs = (a.chatLog ?? []).filter(m => m.role === 'user' || m.role === 'assistant')
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
  const s = useConductorSelector(x => ({ chatAgentTypes: x.chatAgentTypes, settings: x.settings, skillRegistries: x.skillRegistries, personas: x.personas, skills: x.skills }), shallowEqual)
  const { newChatSession } = useActions()
  const types = s.chatAgentTypes.filter(t => t.enabled)
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [model, setModel] = useState('')
  const [cwd, setCwd] = useState(s.settings.defaultCwd || '')
  const [personaId, setPersonaId] = useState('')
  const [advanced, setAdvanced] = useState(false)
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
      {advanced && <>
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
            return <button key={src.id} className="mono" onClick={() => toggleSource(src.id)} style={{
              fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${on ? 'rgba(61,220,151,.35)' : 'var(--line2)'}`,
              background: on ? 'rgba(61,220,151,.1)' : 'transparent', color: on ? 'var(--green)' : 'var(--dim)',
            }}>{src.name}{src.count !== undefined ? ` · ${src.count}` : ''}</button>
          })}
        </div>
      </>}
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="working folder (optional)" className="mono" style={{ ...FIELD, flex: 1, fontSize: 11 }} />
        <button className="open-btn" style={{ flex: 'none', padding: '0 10px', fontSize: 11.5 }} onClick={browse} disabled={!isTauri}>…</button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="icon-btn" title={advanced ? 'Hide chat configuration' : 'Configure model, persona, and skills'} onClick={() => setAdvanced(v => !v)} style={{ width: 30, height: 30, borderRadius: 7 }}>
          <Icon paths={['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M14 4v6', 'M6 14v6']} size={14} stroke={1.7} />
        </button>
        <button className="approve-btn" style={{ padding: 7, fontSize: 12, flex: 1 }} onClick={() => { if (type) onCreated(newChatSession(undefined, cwd, type.id, effModel || undefined, personaId || undefined, sources)) }}>
          Start chat{advanced && type ? ` · ${type.name}` : ''}
        </button>
      </div>
    </div>
  )
}

/** Durable workspace memory editor — what every chat agent here reads at turn
 *  start; agents append via the remember tool, humans prune here. */
function MemoryEditor({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const s = useConductorSelector(x => ({ chatMemory: x.chatMemory }), shallowEqual)
  const { setChatMemory } = useActions()
  const [text, setText] = useState(s.chatMemory[workspaceId] ?? '')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 14, padding: 16 }}>
        <div className="grotesk" style={{ fontSize: 14.5, fontWeight: 600 }}>Workspace memory</div>
        <div style={{ fontSize: 11.5, color: 'var(--mut)', margin: '4px 0 10px', lineHeight: 1.5 }}>
          Durable notes every chat agent in this workspace sees at the start of each turn. Agents add facts with the <span className="mono">remember</span> tool; edit or prune freely — one fact per line.
        </div>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={12}
          placeholder={'- prefers TypeScript strict mode\n- staging deploys happen from the release branch\n- the API docs live in docs/api.md'}
          style={{ ...FIELD, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.6 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <span className="mono" style={{ fontSize: 10, color: text.length > 8000 ? 'var(--red-soft)' : 'var(--dim)' }}>{text.length} / 8000 chars</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="deny-btn" style={{ padding: '7px 16px' }} onClick={onClose}>Cancel</button>
            <button className="approve-btn" style={{ padding: '7px 18px' }} onClick={() => { setChatMemory(workspaceId, text); onClose() }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TagsEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { setChatTags } = useActions()
  const [text, setText] = useState((agent.chatTags ?? []).join(', '))
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 48, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 420, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 8, padding: 16 }}>
        <div className="grotesk" style={{ fontSize: 14, fontWeight: 600 }}>Conversation tags</div>
        <input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="research, client-a, q3" style={{ ...FIELD, marginTop: 10 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          <button className="deny-btn" style={{ padding: '7px 14px' }} onClick={onClose}>Cancel</button>
          <button className="approve-btn" style={{ padding: '7px 16px' }} onClick={() => { setChatTags(agent.id, text.split(',')); onClose() }}>Save</button>
        </div>
      </div>
    </div>
  )
}

export function ChatView() {
  const s = useConductorSelector(x => ({ agents: x.agents, activeChatId: x.activeChatId, activeWorkspace: x.activeWorkspace, settings: x.settings }), shallowEqual)
  const { openChat, deleteSession, renameSession, setChatPermMode, setChatPinned, archiveChat, restoreChat, updateSettings } = useActions()
  // drag-resizable conversation list (persisted like the Master sidebar)
  const listWidth = Math.max(220, Math.min(520, s.settings.chatListWidth ?? 300))
  const startListResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = listWidth
    const move = (ev: PointerEvent) => {
      updateSettings({ chatListWidth: Math.max(220, Math.min(520, startW + ev.clientX - startX)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSearchHit[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  // per-chat Files-panel toggle (explorer + viewer beside the conversation)
  const [filesOpen, setFilesOpen] = useState<Record<string, boolean>>({})
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)

  // chats are workspace-specific (each carries the workspace it was created in)
  const inWorkspace = (a: Agent) => a.kind === 'chat'
    && !!a.archived === showArchived
    && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace
  const chats = s.agents
    .filter(inWorkspace)
    .map(a => ({ agent: a, last: lastSnippet(a) }))
    .sort((x, y) => Number(!!y.agent.chatPinned) - Number(!!x.agent.chatPinned) || y.last.at - x.last.at)

  const selected = s.agents.find(a => a.id === s.activeChatId && inWorkspace(a))

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
      const agent = s.agents.find(a => a.id === h.chatId && inWorkspace(a))
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
      <div style={{ width: listWidth, flexShrink: 0, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', position: 'relative' }}>
        <div
          onPointerDown={startListResize}
          title="Drag to resize"
          style={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px' }}>
          <span className="grotesk" style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>Chats</span>
          <button className="icon-btn" title={showArchived ? 'Show active chats' : 'Show archived chats'} onClick={() => { setShowArchived(v => !v); openChat(null) }} style={{ width: 28, height: 28, borderRadius: 7, color: showArchived ? 'var(--accent)' : undefined }}>
            <Icon paths={['M4 7h16v13H4z', 'M3 4h18v3H3z', 'M9 11h6']} size={14} stroke={1.7} />
          </button>
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
                  width: '100%', display: 'flex', flexDirection: 'column', gap: 3, padding: 'var(--row-pad)', borderRadius: 9,
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
                display: 'flex', alignItems: 'center', gap: 9, padding: 'var(--row-pad)', borderRadius: 9, cursor: 'pointer',
                background: s.activeChatId === a.id ? 'rgba(245,196,81,.08)' : 'transparent',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  {a.chatPinned && <span title="Pinned" style={{ color: 'var(--accent)', fontSize: 10 }}>◆</span>}
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                    {a.name}
                  </span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>{timeLabel(last.at)}</span>
                </div>
                <div style={{ fontSize: 10.5, color: a.status === 'running' ? 'var(--accent)' : 'var(--mut)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                  {a.status === 'running' ? 'thinking…' : last.text || 'empty chat'}
                </div>
                {!!a.chatTags?.length && <div className="mono" style={{ marginTop: 3, fontSize: 9.5, color: 'var(--faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.chatTags.map(tag => `#${tag}`).join(' ')}</div>}
              </div>
              {showArchived ? <>
                <button className="icon-btn" title="Restore chat" style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }} onClick={e => { e.stopPropagation(); restoreChat(a.id) }}>
                  <Icon paths={['M4 12a8 8 0 101.8-5', 'M4 4v5h5']} size={11} stroke={1.8} />
                </button>
                <button className="icon-btn danger" title="Delete permanently" style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }} onClick={e => { e.stopPropagation(); void confirmAction({ title: `Permanently delete “${a.name.slice(0, 40)}”?`, detail: 'Removes the conversation and transcript. This cannot be undone.' }).then(ok => { if (ok) deleteSession(a.id) }) }}>
                  <Icon paths={IC.close} size={10} stroke={2} />
                </button>
              </> : (
                <button className="icon-btn" title="Archive chat" style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }} onClick={e => { e.stopPropagation(); archiveChat(a.id) }}>
                  <Icon paths={['M4 7h16v13H4z', 'M3 4h18v3H3z']} size={11} stroke={1.8} />
                </button>
              )}
            </div>
          )) : (
            <div style={{ fontSize: 11.5, color: 'var(--dim)', padding: '8px 10px', lineHeight: 1.6 }}>
              {showArchived ? 'No archived chats.' : 'No chats yet — hit + to start one.'}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg2)' }}>
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
              <button className="icon-btn" title={selected.chatPinned ? 'Unpin conversation' : 'Pin conversation'} onClick={() => setChatPinned(selected.id, !selected.chatPinned)} style={{ width: 26, height: 26, borderRadius: 7, color: selected.chatPinned ? 'var(--accent)' : undefined }}>
                <Icon paths={['M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z', 'M12 14v7']} size={14} stroke={1.7} />
              </button>
              <button className="icon-btn" title="Edit conversation tags" onClick={() => setTagsOpen(true)} style={{ width: 26, height: 26, borderRadius: 7, color: selected.chatTags?.length ? 'var(--accent)' : undefined }}>
                <Icon paths={['M3 12V5a2 2 0 012-2h7l9 9-9 9-9-9z', 'M8 8h.01']} size={14} stroke={1.7} />
              </button>
              {selected.status === 'running' && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--accent)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
                  thinking
                </span>
              )}
              <button
                className="mono"
                title={(selected.permMode ?? 'ask') === 'ask'
                  ? 'Ask mode: reads run automatically; mutations and external actions need approval — click for auto'
                  : 'Auto mode: risky tools run without asking — click to require approval'}
                onClick={() => setChatPermMode(selected.id, (selected.permMode ?? 'ask') === 'ask' ? 'auto' : 'ask')}
                style={{
                  fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', letterSpacing: 0.4,
                  border: `1px solid ${(selected.permMode ?? 'ask') === 'ask' ? 'rgba(61,220,151,.35)' : 'rgba(245,196,81,.4)'}`,
                  background: 'transparent',
                  color: (selected.permMode ?? 'ask') === 'ask' ? 'var(--green)' : 'var(--accent)',
                }}
              >
                {(selected.permMode ?? 'ask') === 'ask' ? 'ASK' : 'AUTO'}
              </button>
              <button
                className="icon-btn"
                title="Workspace memory — durable notes all chat agents here share"
                onClick={() => setMemoryOpen(true)}
                style={{ width: 26, height: 26, borderRadius: 7 }}
              >
                <Icon paths={['M12 3a7 7 0 00-4 12.7V18a2 2 0 002 2h4a2 2 0 002-2v-2.3A7 7 0 0012 3z', 'M10 22h4']} size={14} stroke={1.7} />
              </button>
              <button
                className="icon-btn"
                title={filesOpen[selected.id] ? 'Hide the file explorer' : 'Browse & preview files next to this chat'}
                onClick={() => setFilesOpen(cur => ({ ...cur, [selected.id]: !cur[selected.id] }))}
                style={{ width: 26, height: 26, borderRadius: 7, color: filesOpen[selected.id] ? 'var(--accent)' : undefined }}
              >
                <Icon paths={['M3 7a2 2 0 012-2h4l2 2h9a1 1 0 011 1v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z']} size={14} stroke={1.7} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <ChatPane agent={selected} active />
              {filesOpen[selected.id] && (
                <div style={{ width: '48%', minWidth: 360, maxWidth: 760, flexShrink: 0, display: 'flex', borderLeft: '1px solid var(--line)' }}>
                  <FilesPane agent={selected} active showSession={false} />
                </div>
              )}
            </div>
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
      {memoryOpen && <MemoryEditor workspaceId={s.activeWorkspace} onClose={() => setMemoryOpen(false)} />}
      {tagsOpen && selected && <TagsEditor agent={selected} onClose={() => setTagsOpen(false)} />}
    </div>
  )
}
