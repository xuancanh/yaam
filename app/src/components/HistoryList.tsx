import { useState } from 'react'
import type { HistoryActor, HistoryEntry, HistoryEventKind } from '../core/types'
import { hexToRgba } from '../core/data'
import { Icon } from './ui'
import { historyContextIndex } from './history-list-model'

const KIND_META: Partial<Record<HistoryEventKind, { color: string; label: string; paths: string[] }>> = {
  approve:  { color: '#3DDC97', label: 'Approved',  paths: ['M5 12l4 4 10-10'] },
  deny:     { color: '#FF7A7A', label: 'Denied',    paths: ['M6 6l12 12', 'M18 6L6 18'] },
  choose:   { color: '#7FD1FF', label: 'Chose',     paths: ['M9 6l6 6-6 6'] },
  dismiss:  { color: '#8B93A1', label: 'Dismissed', paths: ['M6 6l12 12', 'M18 6L6 18'] },
  feedback: { color: '#D9B778', label: 'Feedback',  paths: ['M7 11v9M7 11l2.4-5.2a1.4 1.4 0 012.7.9L11 11h4.4a2 2 0 012 2.4l-1 5a2 2 0 01-2 1.6H7'] },
  send:     { color: '#E7E9F0', label: 'Input',     paths: ['M12 20V5', 'M6 11l6-6 6 6'] },
  launch:   { color: '#3DDC97', label: 'Started',   paths: ['M8 5l11 7-11 7z'] },
  stop:     { color: '#FFB020', label: 'Stopped',   paths: ['M7 5h10v14H7z'] },
  create:   { color: '#7FD1FF', label: 'Created',   paths: ['M12 5v14', 'M5 12h14'] },
  move:     { color: '#7FE3B0', label: 'Moved',     paths: ['M4 6h9', 'M4 18h6', 'M13 6l3 3-3 3', 'M20 6v12'] },
  archive:  { color: '#8B93A1', label: 'Archived',  paths: ['M4 6h16v2H4z', 'M5 10h14v10H5z'] },
  restore:  { color: '#7FD1FF', label: 'Restored',  paths: ['M12 5v14', 'M6 11l6-6 6 6'] },
  delete:   { color: '#FF7A7A', label: 'Deleted',   paths: ['M6 6l12 12', 'M18 6L6 18'] },
  edit:     { color: '#D9B778', label: 'Edited',    paths: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'] },
  schedule: { color: '#7FD1FF', label: 'Schedule',  paths: ['M7 3v18', 'M17 3v18', 'M4 8h16', 'M4 16h16'] },
  task:     { color: '#B78AF7', label: 'Task',      paths: ['M5 5h14v14H5z', 'M8 9h8', 'M8 13h6'] },
  progress: { color: '#F5C451', label: 'Progress',  paths: ['M4 17l5-5 4 3 7-8'] },
  changes:  { color: '#7FD1FF', label: 'Changes',   paths: ['M6 3v12', 'M6 15a3 3 0 103 3', 'M18 9a3 3 0 10-3-3', 'M18 9a9 9 0 01-9 9'] },
  complete: { color: '#3DDC97', label: 'Complete',  paths: ['M5 12l4 4 10-10'] },
  fail:     { color: '#FF7A7A', label: 'Failed',    paths: ['M12 8v5', 'M12 17h.01', 'M4 20h16L12 4z'] },
}

const DEFAULT_META = { color: '#8B93A1', label: 'Activity', paths: ['M12 7v5l3 2', 'M12 3a9 9 0 100 18 9 9 0 000-18z'] }
const ACTOR_LABEL: Record<HistoryActor, string> = { user: 'You', session: 'Session', monitor: 'Monitor', watcher: 'Watcher', system: 'YAAM' }
type Filter = 'all' | 'work' | 'user'

const dayKey = (at: number) => new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Changes({ entry }: { entry: HistoryEntry }) {
  if (!entry.changes?.length) return null
  return (
    <details style={{ marginTop: 7 }}>
      <summary className="mono" style={{ cursor: 'pointer', color: 'var(--mut)', fontSize: 10.5 }}>
        {entry.changes.length} changed file{entry.changes.length === 1 ? '' : 's'}
      </summary>
      <div style={{ marginTop: 5, borderLeft: '1px solid var(--line2)', paddingLeft: 8 }}>
        {entry.changes.map((f, i) => (
          <div key={`${f.path}:${i}`} className="mono" style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 10.5, lineHeight: 1.65, minWidth: 0 }}>
            <span style={{ width: 13, color: f.change === 'deleted' ? 'var(--red-soft)' : f.change === 'added' ? 'var(--green)' : 'var(--accent)', textTransform: 'uppercase' }}>
              {f.change[0]}
            </span>
            <span title={f.from ? `${f.from} → ${f.path}` : f.path} style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.from ? `${f.from} → ${f.path}` : f.path}
            </span>
            {(f.additions !== undefined || f.deletions !== undefined) && (
              <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--green)' }}>+{f.additions ?? 0}</span>{' '}
                <span style={{ color: 'var(--red-soft)' }}>−{f.deletions ?? 0}</span>
              </span>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

export function HistoryList({ entries, emptyHint = 'No activity yet.', scope = 'session' }: {
  entries: HistoryEntry[] | undefined
  emptyHint?: string
  scope?: 'session' | 'task'
}) {
  const list = entries ?? []
  const [filter, setFilter] = useState<Filter>('all')
  const contexts = historyContextIndex(list, scope)
  const visible = filter === 'all' ? list : list.filter(e => filter === 'user' ? (e.actor ?? 'user') === 'user' : (e.actor ?? 'user') !== 'user')
  if (!list.length) {
    return <div style={{ padding: '28px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 12 }}>{emptyHint}</div>
  }
  let lastDay = ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--line)', background: 'var(--panel2)' }}>
        {contexts.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div className="mono" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: .6, marginBottom: 5 }}>
              {scope === 'session' ? 'TASKS IN THIS SESSION' : 'SESSIONS ON THIS TASK'}
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {contexts.map(c => <span key={c.id} title={c.id} style={{ border: '1px solid var(--line2)', borderRadius: 10, padding: '2px 7px', color: 'var(--mut)', fontSize: 10.5 }}>{c.label}</span>)}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 3 }}>
          {([['all', 'All'], ['work', 'Session work'], ['user', 'Your actions']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} style={{ border: 'none', borderRadius: 7, padding: '4px 8px', background: filter === id ? 'var(--bg3)' : 'transparent', color: filter === id ? 'var(--text)' : 'var(--dim)', fontSize: 10.5 }}>{label}</button>
          ))}
        </div>
      </div>
      {!visible.length && <div style={{ padding: 22, textAlign: 'center', color: 'var(--dim)', fontSize: 11.5 }}>No matching activity.</div>}
      {visible.map(e => {
        const meta = KIND_META[e.kind] ?? DEFAULT_META
        const actor = e.actor ?? 'user'
        const day = dayKey(e.at)
        const showDay = day !== lastDay
        lastDay = day
        const context = scope === 'session' ? e.taskTitle : e.sessionName
        return (
          <div key={e.id}>
            {showDay && <div className="mono" style={{ padding: '8px 12px 5px', fontSize: 9.5, color: 'var(--dim)', background: 'var(--bg3)', borderBottom: '1px solid var(--line-soft)' }}>{day}</div>}
            <div style={{ display: 'flex', gap: 9, padding: '9px 12px', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ width: 23, height: 23, borderRadius: 6, flexShrink: 0, color: meta.color, background: hexToRgba(meta.color, 0.15), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon paths={meta.paths} size={12} stroke={1.8} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span className="mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: .35, color: meta.color }}>{meta.label.toUpperCase()}</span>
                  <span style={{ fontSize: 10, color: actor === 'user' ? 'var(--accent)' : 'var(--dim)' }}>{ACTOR_LABEL[actor]}</span>
                  {context && <span title={scope === 'session' ? e.taskId : e.sessionId} style={{ fontSize: 10, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {context}</span>}
                  <time className="mono" dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()} style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 'auto' }}>{stamp(e.at)}</time>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>{e.text}</div>
                {e.detail && <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 3, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 84, overflowY: 'auto' }}>{e.detail}</div>}
                <Changes entry={e} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
