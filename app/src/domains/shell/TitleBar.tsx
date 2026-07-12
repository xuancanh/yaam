import { useState } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { APP_VERSION } from '../../core/addons'
import { isSatelliteWindow } from '../../core/window-role'
import { NOTIF_COLORS, WORKSPACE_COLORS, DEFAULT_WORKSPACE_COLOR, hexToRgba } from '../../core/data'
import { EditableName, IC, Icon, MasterMark } from '../../components/ui'
import { confirmAction } from '../../components/Confirm'

/** Switch, create, rename, delete, and spin workspace-scoped state pools out
 *  into their own OS window. In a spun-out (satellite) window this collapses to a
 *  pinned label — a satellite shows exactly one workspace and cannot switch. */
function WorkspaceSwitcher() {
  const s = useConductorSelector(x => ({ workspaces: x.workspaces, activeWorkspace: x.activeWorkspace, agents: x.agents, detachedWorkspaces: x.detachedWorkspaces, archivedCount: x.archivedWorkspaces?.length ?? 0 }), shallowEqual)
  const { switchWorkspace, createWorkspace, renameWorkspace, archiveWorkspace, setWorkspaceColor, setView } = useActions()
  const [open, setOpen] = useState(false)
  const active = s.workspaces.find(w => w.id === s.activeWorkspace)
  // Count visible sessions assigned to one workspace for its switcher badge.
  const countFor = (id: string) => s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === id).length

  // Satellite window: pinned to one workspace — render a static badge, no switching.
  if (isSatelliteWindow()) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 11px', color: 'var(--text)', fontSize: 12.5, fontWeight: 600 }}>
        <span style={{ color: 'var(--accent)', fontSize: 11 }}>⧉</span>
        {active?.name ?? 'Workspace'}
        <span className="mono" style={{ fontSize: 9, color: 'var(--dim)' }}>window</span>
      </div>
    )
  }

  // Detached workspaces live in their own window — hide from this switcher.
  const detached = s.detachedWorkspaces ?? []
  const visible = s.workspaces.filter(w => !detached.includes(w.id))

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel2)',
          border: '1px solid var(--line)', borderRadius: 8, padding: '5px 11px',
          color: 'var(--text)', fontSize: 12.5, fontWeight: 600,
        }}
      >
        <span style={{ color: active?.color ?? 'var(--accent)', fontSize: 11 }}>▣</span>
        {active?.name ?? 'Default'}
        <span style={{ color: 'var(--dim)', fontSize: 9, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 44 }} />
          <div style={{
            position: 'absolute', top: 36, left: 0, width: 280, background: 'var(--panel2)',
            border: '1px solid var(--line2)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            zIndex: 45, overflow: 'hidden', padding: 6,
          }}>
            {visible.map(w => (
              <div
                key={w.id}
                onClick={() => { if (w.id !== s.activeWorkspace) { switchWorkspace(w.id); setOpen(false) } }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 8,
                  background: w.id === s.activeWorkspace ? 'rgba(245,196,81,.08)' : 'transparent',
                  cursor: w.id === s.activeWorkspace ? 'default' : 'pointer',
                }}
                className={w.id === s.activeWorkspace ? '' : 'palette-item'}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: w.color ?? (w.id === s.activeWorkspace ? 'var(--accent)' : 'var(--line2)'), flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  {w.id === s.activeWorkspace
                    ? <EditableName name={w.name} onRename={name => renameWorkspace(w.id, name)} fontSize={13} />
                    : <span style={{ fontWeight: 600 }}>{w.name}</span>}
                </div>
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{countFor(w.id)}</span>
                {s.workspaces.length > 1 && (
                  <button
                    className="icon-btn"
                    title="Archive workspace (closes its sessions; recover it later from Archived Workspaces)"
                    style={{ width: 20, height: 20, borderRadius: 5 }}
                    onClick={e => {
                      e.stopPropagation()
                      void confirmAction({
                        title: `Archive workspace “${w.name.slice(0, 40)}”?`,
                        detail: 'Closes all its running sessions (including any in a separate window) and moves the workspace — with its board, chats, and schedules — to Archived Workspaces. You can restore it later.',
                        confirmLabel: 'Archive',
                        danger: false,
                      }).then(ok => { if (ok) { archiveWorkspace(w.id); setOpen(false) } })
                    }}
                  >
                    <Icon paths={['M4 7h16v13H4z', 'M2 4h20v3H2z', 'M9 11h6']} size={11} stroke={1.8} />
                  </button>
                )}
              </div>
            ))}
            {active && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px 7px', borderTop: '1px solid var(--line)', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--dim)', marginRight: 2 }}>Accent</span>
                {WORKSPACE_COLORS.map(c => {
                  const on = (active.color ?? DEFAULT_WORKSPACE_COLOR) === c
                  return (
                    <button
                      key={c}
                      title={`Set “${active.name}” accent`}
                      onClick={() => setWorkspaceColor(active.id, c)}
                      style={{
                        width: 16, height: 16, borderRadius: '50%', background: c, padding: 0, cursor: 'pointer',
                        border: on ? '2px solid var(--text)' : '2px solid transparent',
                        boxShadow: on ? `0 0 0 1px ${c}` : 'none',
                      }}
                    />
                  )
                })}
              </div>
            )}
            <button
              className="palette-item"
              onClick={() => { createWorkspace(''); setOpen(false) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                background: 'transparent', border: 'none', borderTop: '1px solid var(--line)',
                marginTop: 4, color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, borderRadius: 8,
              }}
            >
              <Icon paths={IC.plus} size={13} stroke={2} />
              New workspace
            </button>
            <button
              className="palette-item"
              onClick={() => { setView('archived-workspaces'); setOpen(false) }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                background: 'transparent', border: 'none', color: 'var(--mut)', fontSize: 12.5, fontWeight: 600, borderRadius: 8,
              }}
            >
              <Icon paths={['M4 7h16v13H4z', 'M2 4h20v3H2z', 'M9 11h6']} size={13} stroke={1.8} />
              <span style={{ flex: 1, textAlign: 'left' }}>Archived workspaces</span>
              {s.archivedCount > 0 && <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{s.archivedCount}</span>}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Render workspace notifications and actions from the title-bar bell. */
function NotifPopover() {
  const s = useConductorSelector(x => ({ notifications: x.notifications }), shallowEqual)
  const { readAllNotif, clickNotif } = useActions()

  return (
    <div style={{
      position: 'absolute', top: 38, right: 0, width: 340, background: 'var(--panel2)',
      border: '1px solid var(--line2)', borderRadius: 13, boxShadow: '0 18px 50px rgba(0,0,0,.55)',
      zIndex: 45, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
        <span className="grotesk" style={{ fontWeight: 600, fontSize: 13 }}>Notifications</span>
        <button onClick={readAllNotif} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11.5, fontWeight: 600 }}>
          Mark all read
        </button>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto' }}>
        {s.notifications.length === 0 && (
          <div style={{ padding: '24px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 12 }}>
            Nothing yet — session and schedule events show up here.
          </div>
        )}
        {s.notifications.map(n => {
          const color = NOTIF_COLORS[n.kind] || 'var(--mut)'
          return (
            <button
              key={n.id}
              className="notif-item"
              onClick={() => clickNotif(n)}
              style={{
                width: '100%', textAlign: 'left', display: 'flex', gap: 10, padding: '12px 14px',
                background: n.read ? 'transparent' : hexToRgba(NOTIF_COLORS[n.kind] || '#8B93A1', 0.06),
                border: 'none', borderBottom: '1px solid var(--line-soft)',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0, opacity: n.read ? 0 : 1 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.35 }}>{n.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--mut)', marginTop: 2, lineHeight: 1.4 }}>{n.detail}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 3 }}>{n.time}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Render the draggable desktop title bar and global controls. */
export function TitleBar() {
  const s = useConductorSelector(x => ({ agents: x.agents, workspaces: x.workspaces, activeWorkspace: x.activeWorkspace, notifications: x.notifications, notifOpen: x.notifOpen }), shallowEqual)
  const { openPalette, gotoNeeds, toggleNotif, setView, openWorkspaceInWindow } = useActions()
  const needsCount = s.agents.filter(a => a.status === 'needs' && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace).length
  const unread = s.notifications.filter(n => !n.read).length
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const logoColor = s.workspaces.find(w => w.id === s.activeWorkspace)?.color

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 46, flexShrink: 0, background: 'var(--panel)', borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 14px',
      }}
    >
      {/* space for the native macOS traffic lights (titleBarStyle: Overlay) */}
      {isMac && <div data-tauri-drag-region style={{ width: 58, flexShrink: 0 }} />}
      <div data-tauri-drag-region style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <MasterMark size={24} color={logoColor} />
        <span className="grotesk" style={{ fontWeight: 600, fontSize: 15, letterSpacing: 0.2, pointerEvents: 'none' }}>YAAM</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 6px', pointerEvents: 'none' }}>v{APP_VERSION}</span>
      </div>
      <WorkspaceSwitcher />
      <button className="cmdk-btn" onClick={openPalette} style={{ margin: '0 auto' }}>
        <span style={{ color: 'var(--dim)' }}>{isMac ? '⌘K' : 'Ctrl K'}</span>
        <span>Route a task · spin up an agent · build a tool</span>
      </button>
      {needsCount > 0 && (
        <button className="needs-btn" onClick={gotoNeeds}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)', animation: 'cpulse 1.6s ease-in-out infinite' }} />
          {needsCount} needs action
        </button>
      )}
      <button className="icon-btn" title="Activity timeline" style={{ width: 30, height: 30 }} onClick={() => setView('timeline')}>
        <Icon paths={['M3 12h4l2.5 6 5-12 2.5 6h4']} />
      </button>
      <div style={{ position: 'relative' }}>
        <button className="icon-btn" title="Notifications" style={{ width: 30, height: 30, position: 'relative' }} onClick={toggleNotif}>
          <Icon paths={IC.bell} />
          {unread > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
              background: 'var(--red)', color: '#fff', fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
              border: '2px solid var(--panel)',
            }}>
              {unread}
            </span>
          )}
        </button>
        {s.notifOpen && <NotifPopover />}
      </div>
      {!isSatelliteWindow() && s.workspaces.length > 1 && (
        <button
          className="icon-btn"
          title="Open this workspace in a new window"
          style={{ width: 30, height: 30 }}
          onClick={() => openWorkspaceInWindow(s.activeWorkspace)}
        >
          <Icon paths={IC.newWindow} />
        </button>
      )}
    </div>
  )
}
