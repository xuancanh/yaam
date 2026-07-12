// Archived Workspaces page: the only place a workspace can be permanently
// deleted. Each archived workspace keeps its full state (board, chats,
// schedules, and paused session records) and can be restored or deleted — both
// behind a confirm dialog.
import { useConductorSelector, useActions } from '../../store'
import { ViewHeader, Icon } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'
import type { ArchivedWorkspace } from '../../core/entities'

function when(ms: number): string {
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function ArchivedCard({ entry }: { entry: ArchivedWorkspace }) {
  const { restoreWorkspace, deleteArchivedWorkspace, setView } = useActions()
  const name = entry.workspace.name
  const sessions = entry.agents.length
  const tasks = entry.data.tasks?.length ?? 0
  const chats = entry.data.messages?.length ?? 0
  const schedules = entry.data.crons?.length ?? 0

  const restore = () => void confirmAction({
    title: `Restore “${name.slice(0, 40)}”?`,
    detail: 'Brings the workspace back with its board, chats, and schedules. Its sessions return paused — resume them when you need them.',
    confirmLabel: 'Restore',
    danger: false,
  }).then(ok => { if (ok) { restoreWorkspace(entry.workspace.id); setView('workspace') } })

  const remove = () => void confirmAction({
    title: `Permanently delete “${name.slice(0, 40)}”?`,
    detail: 'Erases this archived workspace and everything in it — board, chats, schedules, and session history. This cannot be undone.',
    confirmLabel: 'Delete forever',
    danger: true,
  }).then(ok => { if (ok) deleteArchivedWorkspace(entry.workspace.id) })

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
      background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 12,
    }}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel2)', color: 'var(--dim)' }}>
        <Icon paths={['M4 7h16v13H4z', 'M2 4h20v3H2z', 'M9 11h6']} size={16} stroke={1.7} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>
          archived {when(entry.archivedAt)} · {sessions} session{sessions === 1 ? '' : 's'} · {tasks} task{tasks === 1 ? '' : 's'} · {chats} message{chats === 1 ? '' : 's'} · {schedules} schedule{schedules === 1 ? '' : 's'}
        </div>
      </div>
      <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }} onClick={restore}>
        <Icon paths={['M4 4v6h6', 'M4 10a8 8 0 118 10']} size={13} stroke={1.8} />Restore
      </button>
      <button className="deny-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }} onClick={remove}>
        <Icon paths={['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 13h8l1-13']} size={13} stroke={1.8} />Delete
      </button>
    </div>
  )
}

/** Full page listing archived workspaces with restore / permanent-delete. */
export function ArchivedWorkspacesView() {
  // `?? []` stays OUT of the selector (a fresh array never shallow-equals and
  // loops useSyncExternalStore) — default after selecting the stable ref.
  const archivedRef = useConductorSelector(x => x.archivedWorkspaces)
  const { setView } = useActions()
  const archived = archivedRef ?? []

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ViewHeader title="Archived workspaces">
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>Closed workspaces — restore them or delete them for good</span>
        <div style={{ flex: 1 }} />
        <button className="open-btn" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px' }} onClick={() => setView('workspace')}>
          <Icon paths={['M15 6l-6 6 6 6']} size={14} stroke={1.8} />Back to workspace
        </button>
      </ViewHeader>
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        <div style={{ maxWidth: 900 }}>
          <div style={{ fontSize: 12.5, color: 'var(--mut)', marginBottom: 16, lineHeight: 1.55, maxWidth: 720 }}>
            Closing a workspace archives it here instead of deleting it: its board, chats, schedules, and session
            history are preserved. <b style={{ color: 'var(--text)' }}>Restore</b> brings it back (sessions return paused);
            <b style={{ color: 'var(--text)' }}> Delete</b> removes it permanently.
          </div>
          {archived.length === 0 ? (
            <div style={{ padding: '30px 0', fontSize: 12.5, color: 'var(--dim)' }}>
              No archived workspaces. Closing a workspace from the switcher moves it here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {archived.map(entry => <ArchivedCard key={entry.workspace.id} entry={entry} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
