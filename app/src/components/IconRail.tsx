import { useActions, useConductor } from '../store'
import { hexToRgba, ACCENT } from '../data'
import type { View } from '../types'
import { IC, Icon, MasterMark } from './ui'

const NAV: Array<{ id: View; label: string; paths: string[] }> = [
  { id: 'workspace', label: 'Work', paths: ['M3 5.5h18v13H3z', 'M9.5 5.5v13'] },
  { id: 'overview', label: 'Agents', paths: ['M4 4h6.5v6.5H4z', 'M13.5 4H20v6.5h-6.5z', 'M4 13.5h6.5V20H4z', 'M13.5 13.5H20V20h-6.5z'] },
  { id: 'board', label: 'Board', paths: ['M4 5h4v14H4z', 'M10 5h4v9h-4z', 'M16 5h4v12h-4z'] },
  { id: 'timeline', label: 'Activity', paths: ['M3 12h4l2.5 6 5-12 2.5 6h4'] },
  { id: 'usage', label: 'Usage', paths: ['M4 20V11', 'M10 20V4', 'M16 20v-6', 'M3 20h18'] },
  { id: 'crons', label: 'Cron', paths: ['M12 3.6a8.4 8.4 0 100 16.8 8.4 8.4 0 000-16.8z', 'M12 8v4.3l2.9 1.7'] },
  { id: 'tools', label: 'Tools', paths: ['M6 4v16', 'M12 4v16', 'M18 4v16', 'M6 8.5m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M12 14m-2 0a2 2 0 104 0 2 2 0 10-4 0', 'M18 7m-2 0a2 2 0 104 0 2 2 0 10-4 0'] },
]

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
      {s.addons.length > 0 && <div style={{ width: 32, height: 1, background: 'var(--line)', margin: '4px 0' }} />}
      {s.addons.map(a => {
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
