import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductor } from '../../store'
import type { View } from '../../core/types'
import { Icon } from '../../components/ui'

const ICONS: Record<string, string[]> = {
  route: ['M4 6h9', 'M4 18h6', 'M13 6l3 3-3 3', 'M20 6v12'],
  plus: ['M12 5v14', 'M5 12h14'],
  split: ['M4 5h16v14H4z', 'M12 5v14'],
  build: ['M14 3l-1 5 5-1-8 13 1-6-5 1z'],
  play: ['M8 5l11 7-11 7z'],
  diff: ['M6 3v6a3 3 0 003 3h6', 'M18 21v-6a3 3 0 00-3-3H9', 'M4 5l2-2 2 2', 'M20 19l-2 2-2-2'],
  go: ['M5 12h14', 'M13 6l6 6-6 6'],
}

const NAV_COMMANDS: Array<[View, string]> = [
  ['workspace', 'Go to Workspace'],
  ['chat', 'Go to Chat'],
  ['overview', 'Go to Agents'],
  ['board', 'Go to Board'],
  ['timeline', 'Go to Activity'],
  ['crons', 'Go to Schedules'],
  ['addons', 'Go to Addons'],
  ['settings', 'Go to Settings'],
]

interface Command {
  id: string
  label: string
  hint: string
  icon: string
  run: () => void
}

/** Filter keyboard actions and dispatch the selected command or session focus. */
export function CommandPalette() {
  const s = useConductor()
  const a = useActions()
  const inputRef = useRef<HTMLInputElement>(null)

  // Rebuild static actions plus current idle-session targets for the query.
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      { id: 'route', label: 'Route a task…', hint: 'compose', icon: 'route', run: a.focusComposer },
      { id: 'new', label: 'New agent session', hint: 'spawn', icon: 'plus', run: a.openNewSession },
      { id: 'layout-1', label: 'Layout: single pane', hint: 'layout', icon: 'split', run: () => a.setPaneLayout(1) },
      { id: 'layout-2', label: 'Layout: split vertical', hint: 'layout', icon: 'split', run: () => a.setPaneLayout(2) },
      { id: 'layout-2h', label: 'Layout: split horizontal', hint: 'layout', icon: 'split', run: () => a.setPaneLayout(2, true) },
      { id: 'layout-3', label: 'Layout: 3 panes', hint: 'layout', icon: 'split', run: () => a.setPaneLayout(3) },
      { id: 'layout-4', label: 'Layout: 2×2 grid', hint: 'layout', icon: 'split', run: () => a.setPaneLayout(4) },
      { id: 'build', label: 'Build a tool or panel', hint: 'compose', icon: 'build', run: a.focusComposer },
    ]
    s.agents.filter(x => x.status === 'idle').forEach(x =>
      cmds.push({ id: `res-${x.id}`, label: `Resume ${x.name}`, hint: x.repo, icon: 'play', run: () => a.resume(x.id) }))
    s.agents.filter(x => x.status === 'needs' || x.status === 'running').forEach(x =>
      cmds.push({ id: `rev-${x.id}`, label: `Review changes · ${x.name}`, hint: x.repo, icon: 'diff', run: () => a.openDiff(x.id) }))
    NAV_COMMANDS.forEach(([v, label]) =>
      cmds.push({ id: `nav-${v}`, label, hint: 'navigate', icon: 'go', run: () => a.setView(v) }))
    const q = s.paletteQuery.toLowerCase().trim()
    return q ? cmds.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)) : cmds
  }, [a, s.agents, s.paletteQuery])

  useEffect(() => {
    if (s.paletteOpen) inputRef.current?.focus()
  }, [s.paletteOpen])

  if (!s.paletteOpen) return null

  // Close the palette before invoking the selected action.
  const runCommand = (c: Command) => {
    a.closePalette()
    c.run()
  }

  // Navigate filtered commands and run the active row from the keyboard.
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (commands[0]) runCommand(commands[0])
    }
  }

  return (
    <div
      onClick={a.closePalette}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(4,5,8,.55)', zIndex: 46,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 600, maxWidth: '92vw', background: 'var(--panel2)', border: '1px solid var(--line2)',
          borderRadius: 15, boxShadow: '0 26px 70px rgba(0,0,0,.6)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 17px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ color: 'var(--accent)', display: 'flex' }}>
            <Icon paths={ICONS.route} size={18} stroke={1.7} />
          </span>
          <input
            ref={inputRef}
            value={s.paletteQuery}
            onChange={e => a.setPaletteQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Route a task, jump to a view, build a tool…"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--text)', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 15,
            }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 7px' }}>esc</span>
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: 8 }}>
          {commands.map(c => (
            <button
              key={c.id}
              className="palette-item"
              onClick={() => runCommand(c)}
              style={{
                width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', background: 'transparent', border: 'none', borderRadius: 9, color: 'var(--text)',
              }}
            >
              <span style={{
                width: 30, height: 30, borderRadius: 8, background: '#0A0B0F', border: '1px solid var(--line)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)', flexShrink: 0,
              }}>
                <Icon paths={ICONS[c.icon] || ICONS.go} size={15} stroke={1.7} />
              </span>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>{c.label}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{c.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
