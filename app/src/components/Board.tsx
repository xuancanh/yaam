import { useState } from 'react'
import type { DragEvent } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT } from '../data'
import type { Agent, BoardCol, BoardTask } from '../types'
import { IC, Icon, ViewHeader } from './ui'

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

function SchedulePopover({ card, onClose }: { card: BoardTask; onClose: () => void }) {
  const s = useConductor()
  const { scheduleTask } = useActions()
  const [when, setWhen] = useState(card.scheduleAt ? toLocalInput(card.scheduleAt) : toLocalInput(Date.now() + 3600_000))
  const [templateId, setTemplateId] = useState(card.templateId ?? '')

  const field = {
    width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 7,
    padding: '6px 9px', color: 'var(--text)', outline: 'none', fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace", colorScheme: 'dark',
  } as const

  return (
    <div onClick={e => e.stopPropagation()} style={{
      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 4,
      background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 10,
      boxShadow: '0 14px 40px rgba(0,0,0,.5)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--mut)', letterSpacing: 0.4 }}>SCHEDULE SESSION START</div>
      <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={field} />
      <select value={templateId} onChange={e => setTemplateId(e.target.value)} className="select-field" style={field}>
        <option value="">default agent type</option>
        {s.templates.map(t => <option key={t.id} value={t.id}>template · {t.name} ({t.mode})</option>)}
      </select>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="approve-btn"
          style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }}
          onClick={() => {
            const at = new Date(when).getTime()
            if (!Number.isNaN(at)) scheduleTask(card.id, at, templateId || null)
            onClose()
          }}
        >
          Set
        </button>
        {card.scheduleAt && (
          <button className="deny-btn" style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }} onClick={() => { scheduleTask(card.id, null, null); onClose() }}>
            Clear
          </button>
        )}
        <button className="deny-btn" style={{ flex: 1, padding: '6px 0', fontSize: 11.5 }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

function Card({ card, agent }: { card: BoardTask; agent: Agent | null }) {
  const s = useConductor()
  const { startCardDrag, focusTab, renameTask, deleteTask, startTask } = useActions()
  const [editing, setEditing] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [draft, setDraft] = useState(card.title)

  const commit = () => {
    renameTask(card.id, draft)
    setEditing(false)
  }

  return (
    <div
      className="board-card"
      draggable={!editing}
      onDragStart={e => {
        startCardDrag(card.id)
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', card.id) } catch { /* older webviews */ }
      }}
      onClick={agent && !editing ? () => focusTab(agent.id) : undefined}
      onDoubleClick={e => { e.stopPropagation(); setDraft(card.title); setEditing(true) }}
      style={{
        background: 'var(--panel2)', border: '1px solid var(--line)',
        borderLeft: `3px solid ${agent ? agent.color : 'var(--dim)'}`,
        borderRadius: 10, padding: '11px 12px', cursor: 'grab', position: 'relative',
      }}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          onClick={e => e.stopPropagation()}
          style={{
            width: '100%', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 6,
            padding: '4px 7px', color: 'var(--text)', outline: 'none', fontSize: 12.5, fontWeight: 600,
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.38 }} title="Double-click to rename">{card.title}</div>
      )}
      <button
        className="card-delete"
        title="Delete task"
        onClick={e => { e.stopPropagation(); deleteTask(card.id) }}
        style={{
          position: 'absolute', top: 6, right: 6, width: 20, height: 20, border: 'none',
          background: 'transparent', color: 'var(--dim)', borderRadius: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon paths={IC.close} size={11} stroke={2} />
      </button>
      {card.scheduleAt && !agent && (
        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7, fontSize: 10.5, color: 'var(--accent)' }}>
          <Icon paths={['M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0', 'M12 7v5l3 3']} size={11} stroke={1.8} />
          {new Date(card.scheduleAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          {card.templateId ? ` · ${s.templates.find(t => t.id === card.templateId)?.name ?? ''}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent ? agent.color : 'var(--dim)', flexShrink: 0 }} />
        {agent ? (
          <span style={{ fontSize: 11, color: '#9AA3B2', whiteSpace: 'nowrap' }}>{agent.name}</span>
        ) : (
          <button
            title="Spawn a session for this task"
            onClick={e => { e.stopPropagation(); startTask(card.id) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none',
              color: 'var(--green)', fontSize: 11, fontWeight: 600, padding: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z" /></svg>
            Start session
          </button>
        )}
        {!agent && (
          <button
            title={card.scheduleAt ? 'Change scheduled start' : 'Schedule session start'}
            onClick={e => { e.stopPropagation(); setScheduling(v => !v) }}
            style={{
              display: 'flex', alignItems: 'center', background: 'transparent', border: 'none',
              color: card.scheduleAt ? 'var(--accent)' : 'var(--dim)', padding: 0,
            }}
          >
            <Icon paths={['M12 12m-9 0a9 9 0 1018 0 9 9 0 10-18 0', 'M12 7v5l3 3']} size={12} stroke={1.8} />
          </button>
        )}
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agent ? agent.repo : '—'}
        </span>
      </div>
      {scheduling && <SchedulePopover card={card} onClose={() => setScheduling(false)} />}
    </div>
  )
}

const COLS: Array<{ id: BoardCol; label: string; dot: string }> = [
  { id: 'backlog', label: 'Backlog', dot: '#6B7280' },
  { id: 'routed', label: 'Routed', dot: '#6C8EF5' },
  { id: 'progress', label: 'In progress', dot: '#3DDC97' },
  { id: 'review', label: 'Needs review', dot: '#FFB020' },
  { id: 'done', label: 'Done', dot: '#4a5262' },
]

export function Board() {
  const s = useConductor()
  const { addTask, enterCol, dropTo } = useActions()
  const byId = new Map(s.agents.map(a => [a.id, a]))

  const allowDrop = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Task board">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Drag an unassigned task into Routed/In progress (or hit ▶) to spawn a session for it</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={addTask}>
          <Icon paths={IC.plus} size={14} stroke={1.8} />New task
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden', padding: 16, display: 'flex', gap: 14 }}>
        {COLS.map(col => {
          const cards = s.tasks.filter(t => t.col === col.id)
          return (
            <div
              key={col.id}
              onDragOver={allowDrop}
              onDragEnter={() => enterCol(col.id)}
              onDrop={e => { e.preventDefault(); dropTo(col.id) }}
              style={{
                width: 272, flexShrink: 0, display: 'flex', flexDirection: 'column', background: '#0B0C10',
                border: `1px solid ${s.dragOverCol === col.id ? ACCENT : '#1a1e26'}`,
                borderRadius: 14, minHeight: 0, transition: 'border-color .12s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 14px', borderBottom: '1px solid #1a1e26', flexShrink: 0 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: col.dot }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{col.label}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--mut)', background: 'var(--panel2)', borderRadius: 6, padding: '1px 8px', marginLeft: 2 }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {cards.map(card => (
                  <Card key={card.id} card={card} agent={card.agentId ? byId.get(card.agentId) || null : null} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
