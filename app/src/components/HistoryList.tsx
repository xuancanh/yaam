// Shared renderer for a session's or task's user-action history (newest first).
// Pure presentation: pass it the `history` array off the entity. Used by the
// session Pane's docked History panel and the board task detail's History panel.
import type { HistoryEntry, HistoryEventKind } from '../core/types'
import { hexToRgba } from '../core/data'
import { Icon } from './ui'

/** One glyph + tint per kind, so the list is scannable at a glance:
 *  green = approve/launch, red = deny/delete, blue = choose/create/restore,
 *  amber = feedback/edit, grey = dismiss/archive. */
const KIND_META: Record<HistoryEventKind, { color: string; label: string; paths: string[] }> = {
  approve:  { color: '#3DDC97', label: 'Approved',  paths: ['M5 12l4 4 10-10'] },
  deny:     { color: '#FF7A7A', label: 'Denied',    paths: ['M6 6l12 12', 'M18 6L6 18'] },
  choose:   { color: '#7FD1FF', label: 'Chose',     paths: ['M9 6l6 6-6 6'] },
  dismiss:  { color: '#8B93A1', label: 'Dismissed', paths: ['M6 6l12 12', 'M18 6L6 18'] },
  feedback: { color: '#D9B778', label: 'Feedback',  paths: ['M7 11v9M7 11l2.4-5.2a1.4 1.4 0 012.7.9L11 11h4.4a2 2 0 012 2.4l-1 5a2 2 0 01-2 1.6H7'] },
  send:     { color: '#E7E9F0', label: 'Sent',      paths: ['M12 20V5', 'M6 11l6-6 6 6'] },
  launch:   { color: '#3DDC97', label: 'Launched',  paths: ['M8 5l11 7-11 7z'] },
  stop:     { color: '#FFB020', label: 'Stopped',   paths: ['M7 5h10v14H7z'] },
  create:   { color: '#7FD1FF', label: 'Created',   paths: ['M12 5v14', 'M5 12h14'] },
  move:     { color: '#7FE3B0', label: 'Moved',     paths: ['M4 6h9', 'M4 18h6', 'M13 6l3 3-3 3', 'M20 6v12'] },
  archive:  { color: '#8B93A1', label: 'Archived',  paths: ['M4 6h16v2H4z', 'M5 10h14v10H5z'] },
  restore:  { color: '#7FD1FF', label: 'Restored',  paths: ['M12 5v14', 'M6 11l6-6 6 6'] },
  delete:   { color: '#FF7A7A', label: 'Deleted',   paths: ['M6 6l12 12', 'M18 6L6 18'] },
  edit:     { color: '#D9B778', label: 'Edited',    paths: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'] },
  schedule: { color: '#7FD1FF', label: 'Scheduled', paths: ['M7 3v18', 'M17 3v18', 'M4 8h16', 'M4 16h16'] },
}

const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Render a history feed. Entries are newest-first (as `recordHistory` stores). */
export function HistoryList({ entries, emptyHint = 'No history yet.' }: {
  entries: HistoryEntry[] | undefined
  emptyHint?: string
}) {
  const list = entries ?? []
  if (!list.length) {
    return <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--dim)', fontSize: 12 }}>{emptyHint}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {list.map(e => {
        const meta = KIND_META[e.kind] ?? KIND_META.edit
        return (
          <div key={e.id} style={{ display: 'flex', gap: 9, padding: '7px 12px', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6, flexShrink: 0, color: meta.color,
              background: hexToRgba(meta.color, 0.15), display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon paths={meta.paths} size={12} stroke={1.8} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.4, color: meta.color }}>{meta.label.toUpperCase()}</span>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginLeft: 'auto' }}>{stamp(e.at)}</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 2, lineHeight: 1.4, wordBreak: 'break-word' }}>{e.text}</div>
              {e.detail && (
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 2, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.detail}</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
