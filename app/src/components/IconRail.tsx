import { useActions, useConductor } from '../store'
import { hexToRgba, ACCENT } from '../data'
import type { View } from '../types'
import { IC, Icon, MasterMark } from './ui'

const NAV: Array<{ id: View; label: string; paths: string[] }> = [
  { id: 'workspace', label: 'Work', paths: ['M3 5.5h18v13H3z', 'M9.5 5.5v13'] },
  { id: 'chat', label: 'Chat', paths: ['M4 5h16v11H9l-5 4z', 'M8 9h8', 'M8 12h5'] },
  { id: 'overview', label: 'Agents', paths: ['M4 4h6.5v6.5H4z', 'M13.5 4H20v6.5h-6.5z', 'M4 13.5h6.5V20H4z', 'M13.5 13.5H20V20h-6.5z'] },
  { id: 'board', label: 'Board', paths: ['M4 5h4v14H4z', 'M10 5h4v9h-4z', 'M16 5h4v12h-4z'] },
  { id: 'crons', label: 'Schedule', paths: ['M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8z', 'M12 8v4.3l2.9 1.7'] },
  { id: 'templates', label: 'Templates', paths: ['M4 5h16v4H4z', 'M4 13h9', 'M4 17h9', 'M15 13l4 4', 'M19 13l-4 4'] },
  { id: 'addons', label: 'Addons', paths: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M16.5 13.5v6', 'M13.5 16.5h6'] },
]

/** Render primary navigation plus enabled addon views for the active workspace. */
export function IconRail() {
  const s = useConductor()
  const { setView, openAddon } = useActions()

  return (
    <div style={{
      width: 62, flexShrink: 0, background: 'var(--panel)', borderRight: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', gap: 4,
    }}>
      <div style={{ marginBottom: 8 }}>
        <MasterMark size={34} />
      </div>
      {NAV.map(n => {
        const active = n.id === s.view
        return (
          <button
            key={n.id}
            className="rail-btn"
            title={n.label}
            onClick={() => setView(n.id)}
            style={{
              background: active ? hexToRgba(ACCENT, 0.14) : 'transparent',
              color: active ? 'var(--accent)' : 'var(--mut)',
            }}
          >
            <Icon paths={n.paths} size={21} />
            <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: 0.2 }}>{n.label}</span>
          </button>
        )
      })}
      {s.addons.some(a => a.enabled && a.html) && <div style={{ width: 32, height: 1, background: 'var(--line)', margin: '4px 0' }} />}
      {s.addons.filter(a => a.enabled && a.html).map(a => {
        const active = s.view === 'addon' && s.activeAddon === a.id
        return (
          <button
            key={a.id}
            className="rail-btn"
            title={a.desc || a.name}
            onClick={() => openAddon(a.id)}
            style={{
              background: active ? hexToRgba(ACCENT, 0.14) : 'transparent',
              color: active ? 'var(--accent)' : 'var(--mut)',
            }}
          >
            <span style={{ fontSize: 17, lineHeight: 1 }}>{a.icon}</span>
            <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: 0.2, maxWidth: 46, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
          </button>
        )
      })}
      <div style={{ flex: 1 }} />
      <button
        className="rail-btn"
        title="Settings"
        onClick={() => setView('settings')}
        style={{ width: 44, height: 40, background: 'transparent', color: s.view === 'settings' ? 'var(--accent)' : 'var(--dim)' }}
      >
        <Icon paths={IC.gear} size={20} />
      </button>
    </div>
  )
}
