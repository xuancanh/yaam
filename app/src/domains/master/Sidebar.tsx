// The docked Master panel: header, collapse rail, drag-resize — the
// conversation itself lives in MasterChat (shared with Mission Control).
import { hasCreds } from '../../master'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { Icon, MasterMark } from '../../components/ui'
import { MasterChat } from './MasterChat'

/** Render the resizable Master conversation, composer, and collapsed rail. */
export function Sidebar() {
  const s = useConductorSelector(x => ({
    agents: x.agents, masterBusy: x.masterBusy, settings: x.settings,
  }), shallowEqual)
  const { updateSettings, setView } = useActions()
  const on = s.settings.masterEnabled && hasCreds(s.settings)
  const width = Math.max(280, Math.min(640, s.settings.sidebarWidth ?? 392))

  // Track a window-level pointer drag and persist the clamped sidebar width.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    // Convert horizontal pointer movement into a clamped width update.
    const move = (ev: PointerEvent) => {
      updateSettings({ sidebarWidth: Math.max(280, Math.min(640, startW + ev.clientX - startX)) })
    }
    // Remove global drag listeners and restore the document cursor.
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const runningCount = s.agents.filter(a => a.status === 'running').length

  if (s.settings.sidebarHidden) {
    return (
      <button
        title="Show Master chat"
        onClick={() => updateSettings({ sidebarHidden: false })}
        style={{
          width: 30, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
          border: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '12px 0', gap: 10, cursor: 'pointer',
        }}
      >
        <MasterMark size={20} glow={false} />
        {s.masterBusy && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', animation: 'cpulse 0.9s ease-in-out infinite' }} />
        )}
        <span style={{
          writingMode: 'vertical-rl', fontSize: 10, fontWeight: 600, letterSpacing: 0.6,
          color: 'var(--dim)', marginTop: 2,
        }}>
          MASTER
        </span>
      </button>
    )
  }

  return (
    <div style={{
      width, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, width: 2,
        background: 'linear-gradient(180deg, rgba(245,196,81,.5), transparent 60%)',
      }} />
      <div
        onPointerDown={startResize}
        title="Drag to resize"
        style={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 5 }}
      />

      <div style={{ padding: '15px 17px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 11 }}>
        <MasterMark size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="grotesk" style={{ fontWeight: 600, fontSize: 15 }}>Master</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--panel)', background: 'var(--accent)', borderRadius: 5, padding: '1px 6px', fontWeight: 600 }}>ORCHESTRATOR</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: s.masterBusy ? 'var(--accent)' : 'var(--green)',
              animation: s.masterBusy ? 'cpulse 0.9s ease-in-out infinite' : 'none',
            }} />
            <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
              {s.masterBusy
                ? 'thinking…'
                : <>{runningCount} session{runningCount === 1 ? '' : 's'} running{on
                  ? ` · ${s.settings.masterModel}`
                  : <> · brain off — <button onClick={() => setView('settings')} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--amber)', cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline' }}>configure in Settings</button></>}</>}
            </span>
          </div>
        </div>
        <button
          className="icon-btn"
          title="Open Mission Control — the full-screen command deck"
          style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0 }}
          onClick={() => setView('mission')}
        >
          <Icon paths={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 8a4 4 0 100 8 4 4 0 000-8z', 'M12 12h6.5']} size={14} stroke={1.6} />
        </button>
        <button
          className="icon-btn"
          title="Hide Master chat"
          style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0 }}
          onClick={() => updateSettings({ sidebarHidden: true })}
        >
          <Icon paths={['M15 6l-6 6 6 6']} size={14} stroke={1.8} />
        </button>
      </div>

      <MasterChat />
    </div>
  )
}
