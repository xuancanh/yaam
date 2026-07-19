import { useEffect, useRef, useState } from 'react'
import { IC, Icon } from '../../components/ui'
import { clearTerminalSearch, disableGpuRenderer, enableGpuRenderer, findInTerminal, fitTerminal, getTerminal } from '../../core/terminals'
import { resolveTermPath } from '../../core/terminal-links'
import type { Agent } from '../../core/types'
import { requestOpenFile } from './open-file-bus'

/** Attach a session's registry-owned xterm instance to the current pane DOM. */
export function TerminalPane({ agent, active }: { agent: Agent; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // find bar: Cmd+F (Ctrl+Shift+F) in the terminal, or the header button
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ index: number; count: number } | null>(null)

  // this pane owns the registry callbacks while mounted: find-bar opening,
  // search result counts, and ctrl/cmd+clicked file paths (resolved against
  // the session cwd, then delivered to the Files panel via the bus)
  useEffect(() => {
    const entry = getTerminal(agent.id)
    entry.onSearchOpen = () => {
      setFindOpen(true)
      requestAnimationFrame(() => inputRef.current?.select())
    }
    entry.onSearchResults = (index, count) => setResult({ index, count })
    entry.onOpenFile = path => requestOpenFile(agent.id, resolveTermPath(path, agent.cwd || ''))
    return () => {
      entry.onSearchOpen = null
      entry.onSearchResults = null
      entry.onOpenFile = null
    }
  }, [agent.id, agent.cwd])

  // live search as the query is typed (incremental keeps the active match)
  useEffect(() => {
    if (!findOpen) return
    const timer = window.setTimeout(() => findInTerminal(agent.id, query, 'next', true), 80)
    return () => window.clearTimeout(timer)
  }, [findOpen, query, agent.id])

  const closeFind = () => {
    setFindOpen(false)
    setQuery('')
    setResult(null)
    clearTerminalSearch(agent.id)
    getTerminal(agent.id).term.focus()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { term } = getTerminal(agent.id)
    if (!term.element) {
      term.open(el)
      // fit BEFORE xterm flushes writes queued while the session ran unmounted
      // (one-shot tasks spawn in the background) — otherwise the backlog lays
      // out at the default 80×24 and the pane renders squashed/empty
      if (el.clientHeight > 0) fitTerminal(agent.id)
    } else {
      el.appendChild(term.element)
    }
    enableGpuRenderer(agent.id)
    // fit again after layout settles — fitting synchronously on reattach
    // measures a zero-height container and breaks the viewport
    const raf = requestAnimationFrame(() => {
      fitTerminal(agent.id)
      term.scrollToBottom()
      try { term.refresh(0, term.rows - 1) } catch { /* not measurable yet */ }
    })
    // grids settle late (dividers, group switches) — one delayed re-fit
    const late = window.setTimeout(() => {
      fitTerminal(agent.id)
      term.scrollToBottom()
    }, 150)
    // Coalesce the burst of observer ticks a window/divider drag produces into
    // one fit per frame — refitting on every intermediate size mid-drag left the
    // PTY and renderer briefly disagreeing (offset input/selection).
    let roRaf = 0
    const ro = new ResizeObserver(() => {
      if (roRaf) return
      roRaf = requestAnimationFrame(() => {
        roRaf = 0
        // self-heal: if another (since unmounted) host detached the singleton
        // xterm element, re-adopt it — but never steal it from a live host
        if (term.element && !term.element.parentElement) el.appendChild(term.element)
        fitTerminal(agent.id)
      })
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      if (roRaf) cancelAnimationFrame(roRaf)
      window.clearTimeout(late)
      ro.disconnect()
      // React can mount the destination pane before cleaning up the source
      // pane. Only the host that still owns xterm may release its renderer;
      // otherwise this obsolete cleanup would disable WebGL in the new pane.
      if (term.element && term.element.parentElement === el) {
        disableGpuRenderer(agent.id)
        el.removeChild(term.element)
      }
    }
  }, [agent.id])

  useEffect(() => {
    if (active) getTerminal(agent.id).term.focus()
  }, [active, agent.id])

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div
        ref={ref}
        onMouseDown={() => {
          // interacting with the pane steals terminal focus back from any
          // remote device — refit to the desktop's own size
          fitTerminal(agent.id)
          getTerminal(agent.id).term.focus()
        }}
        style={{
          flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden',
          background: 'var(--bg2)', padding: '8px 2px 2px 10px',
        }}
      />
      {findOpen && (
        <div style={{
          position: 'absolute', top: 6, right: 14, zIndex: 5,
          display: 'flex', alignItems: 'center', gap: 3, padding: '3px 6px',
          background: 'var(--panel)', border: '1px solid var(--line2)', borderRadius: 8,
          boxShadow: '0 6px 20px rgba(0,0,0,.3)',
        }}>
          <input
            ref={inputRef}
            className="mono"
            value={query}
            placeholder="Find…"
            autoFocus
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') findInTerminal(agent.id, query, e.shiftKey ? 'prev' : 'next')
              if (e.key === 'Escape') closeFind()
            }}
            style={{ width: 150, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 11.5 }}
          />
          <span className="mono" style={{ fontSize: 10, color: 'var(--dim)', minWidth: 36, textAlign: 'right' }}>
            {query ? (result?.count === -1 ? 'match' : '0') : ''}
          </span>
          <button
            className="icon-btn"
            title="Previous match (Shift+Enter)"
            style={{ width: 20, height: 20, borderRadius: 5 }}
            onClick={() => findInTerminal(agent.id, query, 'prev')}
          >
            <Icon paths={['M6 15l6-6 6 6']} size={11} stroke={1.8} />
          </button>
          <button
            className="icon-btn"
            title="Next match (Enter)"
            style={{ width: 20, height: 20, borderRadius: 5 }}
            onClick={() => findInTerminal(agent.id, query, 'next')}
          >
            <Icon paths={['M6 9l6 6 6-6']} size={11} stroke={1.8} />
          </button>
          <button
            className="icon-btn"
            title="Close (Esc)"
            style={{ width: 20, height: 20, borderRadius: 5 }}
            onClick={closeFind}
          >
            <Icon paths={IC.close} size={9} stroke={2} />
          </button>
        </div>
      )}
    </div>
  )
}
