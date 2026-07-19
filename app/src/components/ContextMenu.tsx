import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CONTEXT_MENU_EDGE, contextMenuPlacement } from './context-menu'

/** Shared viewport-level shell for right-click menus. It measures real content,
 * clamps every edge, owns dismissal, and provides keyboard item navigation. */
export function ContextMenu({ x, y, width = 224, label, header, onClose, children }: {
  x: number
  y: number
  width?: number
  label: string
  header?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: CONTEXT_MENU_EDGE, left: CONTEXT_MENU_EDGE, ready: false })

  useLayoutEffect(() => {
    const place = () => {
      const box = menu.current?.getBoundingClientRect()
      const measuredWidth = box?.width ?? Math.min(width, window.innerWidth - CONTEXT_MENU_EDGE * 2)
      const measuredHeight = box?.height ?? 160
      setPosition({ ...contextMenuPlacement(x, y, measuredWidth, measuredHeight, window.innerWidth, window.innerHeight), ready: true })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [width, x, y])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    const frame = window.requestAnimationFrame(() => {
      menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const moveFocus = (event: ReactKeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next].focus()
  }

  return createPortal((
    <>
      <div
        aria-hidden="true"
        className="context-menu-backdrop"
        onPointerDown={event => { event.stopPropagation(); onClose() }}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
      />
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        className="context-menu"
        onKeyDown={moveFocus}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
        style={{
          top: position.top, left: position.left, width,
          maxWidth: `calc(100vw - ${CONTEXT_MENU_EDGE * 2}px)`,
          maxHeight: `calc(100vh - ${CONTEXT_MENU_EDGE * 2}px)`,
          visibility: position.ready ? 'visible' : 'hidden',
        }}
      >
        {header && <div className="context-menu-header">{header}</div>}
        <div className="context-menu-items">{children}</div>
      </div>
    </>
  ), document.body)
}
