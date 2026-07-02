import type { DragEvent } from 'react'
import { useActions, useConductor } from '../store'
import { ACCENT } from '../data'
import type { BoardCol } from '../types'
import { IC, Icon, ViewHeader } from './ui'

const COLS: Array<{ id: BoardCol; label: string; dot: string }> = [
  { id: 'backlog', label: 'Backlog', dot: '#6B7280' },
  { id: 'routed', label: 'Routed', dot: '#6C8EF5' },
  { id: 'progress', label: 'In progress', dot: '#3DDC97' },
  { id: 'review', label: 'Needs review', dot: '#FFB020' },
  { id: 'done', label: 'Done', dot: '#4a5262' },
]

export function Board() {
  const s = useConductor()
  const { addTask, startCardDrag, enterCol, dropTo, focusTab } = useActions()
  const byId = new Map(s.agents.map(a => [a.id, a]))

  const allowDrop = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Task board">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Drag tasks across stages — cards link to their agent</span>
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
                {cards.map(card => {
                  const agent = card.agentId ? byId.get(card.agentId) : null
                  return (
                    <div
                      key={card.id}
                      className="board-card"
                      draggable
                      onDragStart={e => {
                        startCardDrag(card.id)
                        e.dataTransfer.effectAllowed = 'move'
                        try { e.dataTransfer.setData('text/plain', card.id) } catch { /* older webviews */ }
                      }}
                      onClick={agent ? () => focusTab(agent.id) : undefined}
                      style={{
                        background: 'var(--panel2)', border: '1px solid var(--line)',
                        borderLeft: `3px solid ${agent ? agent.color : 'var(--dim)'}`,
                        borderRadius: 10, padding: '11px 12px', cursor: 'grab',
                      }}
                    >
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.38 }}>{card.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: agent ? agent.color : 'var(--dim)', flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: '#9AA3B2', whiteSpace: 'nowrap' }}>{agent ? agent.name : 'Unassigned'}</span>
                        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {agent ? agent.repo : '—'}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
