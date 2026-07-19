import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Agent, BoardTask } from '../../core/types'
import { indicatorColor } from '../../core/data'
import { readScreen } from '../../core/terminals'
import { sessionWorkStatus } from './session-work-status'

function previewLines(agent: Agent): string[] {
  const rendered = readScreen(agent.id, 12)
  if (rendered.length) return rendered
  return agent.log.slice(-12).map(line => line.x).filter(Boolean)
}

function PreviewCard({ agent, task, anchor }: { agent: Agent; task?: BoardTask; anchor: HTMLElement }) {
  const status = sessionWorkStatus(agent, task)
  const card = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState(() => previewLines(agent))
  const [position, setPosition] = useState({ top: 0, left: 0, ready: false })

  useEffect(() => {
    setLines(previewLines(agent))
    const timer = window.setInterval(() => setLines(previewLines(agent)), 700)
    return () => window.clearInterval(timer)
  }, [agent])

  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.getBoundingClientRect()
      const width = Math.min(420, window.innerWidth - 20)
      const height = card.current?.offsetHeight ?? 360
      const left = Math.max(10, Math.min(box.left, window.innerWidth - width - 10))
      const below = box.bottom + 8
      const top = below + height <= window.innerHeight - 10
        ? below
        : Math.max(10, box.top - height - 8)
      setPosition({ top, left, ready: true })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, lines.length])

  return createPortal((
    <div
      ref={card}
      role="tooltip"
      style={{
        position: 'fixed', top: position.top, left: position.left, zIndex: 80,
        width: 'min(420px, calc(100vw - 20px))', pointerEvents: 'none', visibility: position.ready ? 'visible' : 'hidden',
        background: 'var(--panel2)', border: '1px solid var(--line2)', borderRadius: 12,
        boxShadow: '0 18px 48px rgba(0,0,0,.52)', overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: indicatorColor(agent), flexShrink: 0 }} />
        <strong style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</strong>
        <span className="mono" style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase' }}>{agent.status}</span>
      </div>
      <div style={{ display: 'grid', gap: 7, padding: '10px 12px' }}>
        {([
          ['TASK', status.task, 'var(--accent)'],
          ['NOW', status.current, 'var(--text)'],
          ['NEXT', status.next, agent.actionNeeded || task?.awaitingUser ? 'var(--amber)' : 'var(--green)'],
        ] as const).map(([label, value, color]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr)', gap: 7, alignItems: 'start' }}>
            <span className="mono" style={{ fontSize: 9, letterSpacing: .55, color: 'var(--dim)', paddingTop: 1 }}>{label}</span>
            <span style={{ fontSize: 11.5, lineHeight: 1.35, color, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{value}</span>
          </div>
        ))}
        {task?.description && (
          <div style={{ marginTop: 1, paddingTop: 8, borderTop: '1px solid var(--line-soft)', fontSize: 10.5, lineHeight: 1.4, color: 'var(--mut)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {task.description}
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)', padding: '8px 10px 9px' }}>
        <div className="mono" style={{ fontSize: 8.5, letterSpacing: .65, color: 'var(--dim)', marginBottom: 6 }}>LIVE SESSION PREVIEW</div>
        <div className="mono" style={{ height: 128, overflow: 'hidden', fontSize: 9.5, lineHeight: 1.32, color: 'var(--mut2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {lines.length ? lines.join('\n') : 'No terminal output yet.'}
        </div>
      </div>
    </div>
  ), document.body)
}

/** Hover-intent wrapper for tab/sidebar rows. `display: contents` preserves the
 * existing flex/grid layout while the first child remains the placement anchor. */
export function SessionHoverPreview({ agent, task, children }: { agent: Agent; task?: BoardTask; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  const open = () => {
    cancel()
    timer.current = window.setTimeout(() => {
      const target = host.current?.firstElementChild
      if (target instanceof HTMLElement) setAnchor(target)
    }, 420)
  }
  const close = () => { cancel(); setAnchor(null) }

  useEffect(() => () => cancel(), [])
  return (
    <span ref={host} onMouseEnter={open} onMouseLeave={close} style={{ display: 'contents' }}>
      {children}
      {anchor && <PreviewCard agent={agent} task={task} anchor={anchor} />}
    </span>
  )
}
