import { useState } from 'react'
import { useActions, useConductor } from '../store'
import { NOTIF_COLORS, hexToRgba } from '../data'
import { EditableName, IC, Icon, MasterMark } from './ui'

function WorkspaceSwitcher() {
  const s = useConductor()
  const { switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace } = useActions()
  const [open, setOpen] = useState(false)
  const active = s.workspaces.find(w => w.id === s.activeWorkspace)
  const countFor = (id: string) => s.agents.filter(a => !a.archived && (a.workspaceId ?? s.activeWorkspace) === id).length

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
        <span style={{ color: 'var(--accent)', fontSize: 11 }}>▣</span>
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
            {s.workspaces.map(w => (
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
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: w.id === s.activeWorkspace ? 'var(--accent)' : 'var(--line2)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  {w.id === s.activeWorkspace
                    ? <EditableName name={w.name} onRename={name => renameWorkspace(w.id, name)} fontSize={13} />
                    : <span style={{ fontWeight: 600 }}>{w.name}</span>}
                </div>
                <span className="mono" style={{ fontSize: 10, color: 'var(--dim)' }}>{countFor(w.id)}</span>
                {s.workspaces.length > 1 && (
                  <button
                    className="icon-btn danger"
                    title="Delete workspace (kills its sessions)"
                    style={{ width: 20, height: 20, borderRadius: 5 }}
                    onClick={e => { e.stopPropagation(); deleteWorkspace(w.id) }}
                  >
                    <Icon paths={IC.close} size={10} stroke={2} />
                  </button>
                )}
              </div>
            ))}
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
          </div>
        </>
      )}
    </div>
  )
}

function NotifPopover() {
  const s = useConductor()
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
                border: 'none', borderBottom: '1px solid #1a1e26',
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

export function TitleBar() {
  const s = useConductor()
  const { openPalette, gotoNeeds, toggleNotif } = useActions()
  const needsCount = s.agents.filter(a => a.status === 'needs' && (a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace).length
  const unread = s.notifications.filter(n => !n.read).length
  const isMac = navigator.platform.toUpperCase().includes('MAC')

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
        <MasterMark size={24} />
        <span className="grotesk" style={{ fontWeight: 600, fontSize: 15, letterSpacing: 0.2, pointerEvents: 'none' }}>YAAM</span>
        <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 6px', pointerEvents: 'none' }}>v0.9</span>
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
      <div className="grotesk" style={{
        width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(140deg,#3a4150,#20242d)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600,
        color: '#C7CCD6', border: '1px solid var(--line2)',
      }}>
        KP
      </div>
    </div>
  )
}
