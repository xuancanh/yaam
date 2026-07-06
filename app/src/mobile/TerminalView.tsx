// Real terminal rendering for the companion: the SAME xterm.js the desktop
// uses. Preferred source is the LIVE raw-byte SSE stream served straight from
// the Rust PTY reader; fallback is replaying the serialized snapshot buffer.
// The terminal FITS its container (FitAddon + ResizeObserver) so lines wrap to
// the phone's width and the PTY-side layout reflows readably.
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { apiUrl, deviceToken, sendCommand } from './api'

// desktop dark terminal palette (core/terminals.ts DARK_TERM)
const THEME = {
  background: '#0A0B0F', foreground: '#C7CCD6', cursor: '#F5C451',
  selectionBackground: 'rgba(245,196,81,.28)',
  black: '#1a1e26', red: '#FF7A7A', green: '#3DDC97', yellow: '#F5C451',
  blue: '#7FD1FF', magenta: '#C77DFF', cyan: '#7FE3B0', white: '#E7E9F0',
  brightBlack: '#4a5262', brightRed: '#FF9B9B', brightGreen: '#7FE3B0',
  brightYellow: '#FFD98A', brightBlue: '#A8DFFF', brightMagenta: '#DCA9FF',
  brightCyan: '#A5F0CC', brightWhite: '#FFFFFF',
}

function b64Bytes(data: string): Uint8Array {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function TerminalView({ sessionId, data }: { sessionId: string; data: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const lastRef = useRef<string>('')
  const [live, setLive] = useState(true)

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      lineHeight: 1.25,
      fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      scrollback: 600,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    termRef.current = term
    // exclusive terminal focus: viewing this terminal steals it — the desktop
    // resizes the REAL PTY (and its own xterm) to our dimensions, so the byte
    // stream is laid out for this screen. Leaving hands it back (blur).
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    const claimFocus = () => {
      if (focusTimer) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        void sendCommand({ kind: 'session_focus', id: sessionId, text: JSON.stringify({ rows: term.rows, cols: term.cols }) })
      }, 250)
    }
    const refit = () => {
      try { fit.fit(); term.scrollToBottom() } catch { /* mid-unmount */ }
      claimFocus()
    }
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(hostRef.current!)
    // touch scrolling: xterm's canvas eats the touches before its scrollable
    // viewport sees them — translate vertical drags into scrollLines ourselves.
    // Pointer Events (with capture) work on BOTH Android Chrome and iOS Safari
    // (13+ honors touch-action: none for them); plain touch handlers were
    // Android-only in practice.
    const host = hostRef.current!
    const cellH = Math.max(10, 11 * 1.25) // fontSize × lineHeight
    let tracking = false
    let lastY = 0
    let carry = 0
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return // desktop keeps native wheel/select
      tracking = true
      lastY = e.clientY
      carry = 0
      try { host.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    }
    const onMove = (e: PointerEvent) => {
      if (!tracking) return
      carry += (lastY - e.clientY) / cellH
      lastY = e.clientY
      const lines = Math.trunc(carry)
      if (lines !== 0) {
        carry -= lines
        term.scrollLines(lines)
      }
    }
    const onUp = () => { tracking = false }
    // belt for older iOS: keep the browser from rubber-banding the page
    const onTouchMove = (e: TouchEvent) => e.preventDefault()
    host.addEventListener('pointerdown', onDown)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerup', onUp)
    host.addEventListener('pointercancel', onUp)
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      host.removeEventListener('pointerdown', onDown)
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerup', onUp)
      host.removeEventListener('pointercancel', onUp)
      host.removeEventListener('touchmove', onTouchMove)
      ro.disconnect()
      if (focusTimer) clearTimeout(focusTimer)
      void sendCommand({ kind: 'session_blur', id: sessionId }) // desktop reclaims
      term.dispose()
      termRef.current = null
      lastRef.current = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // live mode: raw PTY bytes over SSE, straight from the Rust session tap
  useEffect(() => {
    if (!live) return
    let es: EventSource | null = null
    try {
      es = new EventSource(apiUrl('/api/term', { d: deviceToken(), id: sessionId }))
      es.onmessage = e => {
        const term = termRef.current
        if (!term || !e.data) return
        // stick to the bottom only when the user is already there — scrolling
        // back through history must not get yanked down by live output
        const buf = term.buffer.active
        const wasAtBottom = buf.viewportY >= buf.baseY
        term.write(b64Bytes(String(e.data)), () => { if (wasAtBottom) term.scrollToBottom() })
      }
      es.onerror = () => { es?.close(); setLive(false) } // fall back to snapshots
    } catch {
      setLive(false)
    }
    return () => es?.close()
  }, [live, sessionId])

  // snapshot fallback: replay the serialized buffer whenever it changes
  useEffect(() => {
    const term = termRef.current
    if (!term || live || data === lastRef.current) return
    lastRef.current = data
    term.reset()
    term.write(data, () => term.scrollToBottom())
  }, [data, live])

  return <div ref={hostRef} className="termfill" />
}
