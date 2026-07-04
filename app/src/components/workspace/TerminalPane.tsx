import { useEffect, useRef } from 'react'
import { fitTerminal, getTerminal } from '../../terminals'
import type { Agent } from '../../types'

/** Attach a session's registry-owned xterm instance to the current pane DOM. */
export function TerminalPane({ agent, active }: { agent: Agent; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { term } = getTerminal(agent.id)
    if (!term.element) term.open(el)
    else el.appendChild(term.element)
    // fit after layout settles — fitting synchronously on reattach measures a
    // zero-height container and breaks the viewport (no scroll, no cursor)
    const raf = requestAnimationFrame(() => {
      fitTerminal(agent.id)
      try { term.refresh(0, term.rows - 1) } catch { /* not measurable yet */ }
    })
    const ro = new ResizeObserver(() => fitTerminal(agent.id))
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (term.element && term.element.parentElement === el) el.removeChild(term.element)
    }
  }, [agent.id])

  useEffect(() => {
    if (active) getTerminal(agent.id).term.focus()
  }, [active, agent.id])

  return (
    <div
      ref={ref}
      onMouseDown={() => getTerminal(agent.id).term.focus()}
      style={{
        flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden',
        background: '#0A0B0F', padding: '8px 2px 2px 10px',
      }}
    />
  )
}
