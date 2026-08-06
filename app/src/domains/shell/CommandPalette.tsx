import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { steppedUiScale } from '../../app/appearance'
import type { View } from '../../core/types'
import { Icon } from '../../components/ui'
import { activeSessionId, workspaceTabOrder } from '../session/layout-state'
import { brainOn } from '../../llm/client'

const ICONS: Record<string, string[]> = {
  route: ['M4 6h9', 'M4 18h6', 'M13 6l3 3-3 3', 'M20 6v12'],
  plus: ['M12 5v14', 'M5 12h14'],
  split: ['M4 5h16v14H4z', 'M12 5v14'],
  build: ['M14 3l-1 5 5-1-8 13 1-6-5 1z'],
  play: ['M8 5l11 7-11 7z'],
  diff: ['M6 3v6a3 3 0 003 3h6', 'M18 21v-6a3 3 0 00-3-3H9', 'M4 5l2-2 2 2', 'M20 19l-2 2-2-2'],
  go: ['M5 12h14', 'M13 6l6 6-6 6'],
  term: ['M4 5h16v14H4z', 'M7.5 9.5l3 2.5-3 2.5', 'M12.5 15h4'],
}

const NAV_COMMANDS: Array<[View, string, string?]> = [
  ['workspace', 'Go to Workspace'],
  ['chat', 'Go to Chat'],
  ['overview', 'Go to Agents'],
  ['board', 'Go to Board'],
  ['timeline', 'Go to Activity'],
  ['crons', 'Go to Schedules'],
  ['templates', 'Go to Templates'],
  ['addons', 'Go to Addons'],
  ['settings', 'Go to Settings', '⌘,'],
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
  const s = useConductorSelector(x => ({ agents: x.agents, activeWorkspace: x.activeWorkspace, groups: x.groups, activeGroup: x.activeGroup, paletteOpen: x.paletteOpen, paletteQuery: x.paletteQuery, settings: x.settings }), shallowEqual)
  const a = useActions()
  const inputRef = useRef<HTMLInputElement>(null)

  // Rebuild static actions plus current idle-session targets for the query.
  const commands = useMemo<Command[]>(() => {
    const zoom = (dir: -1 | 0 | 1) =>
      a.updateSettings({ appearance: { ...s.settings.appearance, uiScale: steppedUiScale(s.settings.appearance?.uiScale, dir) } })
    const master = brainOn(s.settings)
    const cmds: Command[] = [
      // the master composer can only refuse without a brain — route to Settings
      ...(master ? [{ id: 'route', label: 'Route a task…', hint: 'compose', icon: 'route', run: a.focusComposer }] : []),
      { id: 'new', label: 'New agent session', hint: '⌘T', icon: 'plus', run: a.openNewSession },
      { id: 'newtask', label: 'New board task', hint: '⌘N', icon: 'plus', run: a.openNewTask },
      { id: 'layout-1', label: 'Layout: single pane', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([1]) },
      { id: 'layout-2', label: 'Layout: split vertical', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([2]) },
      { id: 'layout-2h', label: 'Layout: split horizontal', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([1, 1]) },
      { id: 'layout-3', label: 'Layout: 3 panes', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([2, 1]) },
      { id: 'layout-4', label: 'Layout: 2×2 grid', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([2, 2]) },
      { id: 'layout-5', label: 'Layout: 5 panes', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([2, 3]) },
      { id: 'layout-6', label: 'Layout: 3×2 grid', hint: 'layout', icon: 'split', run: () => a.setPaneLayout([3, 3]) },
      { id: 'zoom-in', label: 'Zoom in', hint: '⌘+', icon: 'go', run: () => zoom(1) },
      { id: 'zoom-out', label: 'Zoom out', hint: '⌘−', icon: 'go', run: () => zoom(-1) },
      { id: 'zoom-reset', label: 'Reset zoom', hint: '⌘0', icon: 'go', run: () => zoom(0) },
      { id: 'master', label: `${s.settings.sidebarHidden ? 'Show' : 'Hide'} Master panel`, hint: '⌘B', icon: 'split', run: () => a.updateSettings({ sidebarHidden: !s.settings.sidebarHidden }) },
      ...(master
        ? [{ id: 'build', label: 'Build a tool or panel', hint: 'compose', icon: 'build', run: a.focusComposer }]
        : [{ id: 'brain', label: 'Set up the Master Brain…', hint: 'settings', icon: 'build', run: () => a.setView('settings') }]),
    ]
    // terminal navigation: jump to any session by name (⌘1–9 order), or cycle
    const order = workspaceTabOrder({ agents: s.agents, groups: s.groups, activeWorkspace: s.activeWorkspace })
    const byId = new Map(s.agents.map(x => [x.id, x]))
    if (order.length > 1) {
      const at = Math.max(0, order.indexOf(activeSessionId({ groups: s.groups, activeGroup: s.activeGroup }) ?? ''))
      const step = (d: number) => a.focusTab(order[(at + d + order.length) % order.length])
      cmds.push({ id: 'term-next', label: 'Focus next terminal', hint: 'navigate', icon: 'term', run: () => step(1) })
      cmds.push({ id: 'term-prev', label: 'Focus previous terminal', hint: 'navigate', icon: 'term', run: () => step(-1) })
    }
    order.forEach((id, i) => {
      const x = byId.get(id)
      if (!x) return
      const kbd = i < 9 ? `⌘${i + 1} · ` : ''
      cmds.push({ id: `focus-${id}`, label: `Focus terminal · ${x.name}`, hint: `${kbd}${x.repo}`, icon: 'term', run: () => a.focusTab(id) })
    })
    const workspaceAgents = s.agents.filter(x => !x.archived
      && x.kind !== 'chat'
      && (x.workspaceId ?? s.activeWorkspace) === s.activeWorkspace)
    workspaceAgents.filter(x => x.status === 'idle').forEach(x =>
      cmds.push({ id: `res-${x.id}`, label: `Resume ${x.name}`, hint: x.repo, icon: 'play', run: () => a.resume(x.id) }))
    workspaceAgents.filter(x => x.status === 'needs' || x.status === 'running').forEach(x =>
      cmds.push({ id: `rev-${x.id}`, label: `Review changes · ${x.name}`, hint: x.repo, icon: 'diff', run: () => a.openDiff(x.id) }))
    NAV_COMMANDS.forEach(([v, label, kbd]) =>
      cmds.push({ id: `nav-${v}`, label, hint: kbd ?? 'navigate', icon: 'go', run: () => a.setView(v) }))
    const q = s.paletteQuery.toLowerCase().trim()
    return q ? cmds.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)) : cmds
  }, [a, s.agents, s.activeWorkspace, s.groups, s.activeGroup, s.settings, s.paletteQuery])

  // keyboard cursor over the filtered list; follows the query, resets on open
  const [sel, setSel] = useState(0)
  useEffect(() => setSel(0), [s.paletteQuery, s.paletteOpen])
  const selected = Math.min(sel, commands.length - 1)
  // last real pointer position — keyboard-driven scrollIntoView re-fires
  // mousemove on the row under the stationary cursor; same-coords events are
  // scroll artifacts, not the user pointing, and must not steal the selection
  const pointer = useRef<{ x: number; y: number } | null>(null)

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
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!commands.length) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      setSel((selected + d + commands.length) % commands.length)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (commands[selected]) runCommand(commands[selected])
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
              color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 15,
            }}
          />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--dim)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 7px' }}>esc</span>
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: 8 }}>
          {commands.map((c, i) => (
            <button
              key={c.id}
              className="palette-item"
              onClick={() => runCommand(c)}
              onMouseMove={e => {
                const p = pointer.current
                if (p && p.x === e.clientX && p.y === e.clientY) return
                pointer.current = { x: e.clientX, y: e.clientY }
                setSel(i)
              }}
              ref={el => { if (i === selected) el?.scrollIntoView({ block: 'nearest' }) }}
              style={{
                width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 12px', background: i === selected ? 'var(--bg2)' : 'transparent',
                border: 'none', borderRadius: 9, color: 'var(--text)',
              }}
            >
              <span style={{
                width: 30, height: 30, borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--line)',
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
