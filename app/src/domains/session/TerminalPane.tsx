import { useEffect, useRef } from 'react'
import { fitTerminal, getTerminal } from '../../core/terminals'
import type { Agent } from '../../types'

/** Attach a session's registry-owned xterm instance to the current pane DOM. */
export function TerminalPane({ agent, active }: { agent: Agent; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)

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
    const ro = new ResizeObserver(() => fitTerminal(agent.id))
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(late)
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
