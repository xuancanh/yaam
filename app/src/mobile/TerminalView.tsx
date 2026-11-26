// Real terminal rendering for the companion: the SAME xterm.js the desktop
// uses. Preferred source is the LIVE raw-byte SSE stream served straight from
// the Rust PTY reader; fallback is replaying the serialized snapshot buffer.
// The terminal FITS its container (FitAddon + ResizeObserver) so lines wrap to
// the phone's width and the PTY-side layout reflows readably.
import { memo, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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

// Memoized: in live mode the terminal drives itself from its own /api/term SSE,
// so a whole-tree re-render on every state snapshot must not re-run this body.
export const TerminalView = memo(function TerminalView({ sessionId, data }: { sessionId: string; data: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const lastRef = useRef<string>('')
  const [live, setLive] = useState(true)
  const liveRef = useRef(live)
  liveRef.current = live
  const resetScrollRef = useRef<() => void>(() => {})
  const claimRef = useRef<() => void>(() => {})

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
    // GPU rendering: the DOM renderer re-lays-out a span per row on every
    // scroll step, which is what made touch scrolling stutter. One terminal
    // is on screen at a time, so a single WebGL context is safe here.
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => gl.dispose()) // xterm falls back to the DOM renderer
      term.loadAddon(gl)
    } catch { /* no WebGL (old webview) — DOM renderer still works */ }
    termRef.current = term
    // exclusive terminal focus: viewing this terminal steals it — the desktop
    // resizes the REAL PTY (and its own xterm) to our dimensions, so the byte
    // stream is laid out for this screen. Leaving hands it back (blur).
    let focusTimer: ReturnType<typeof setTimeout> | null = null
    const claimFocus = () => {
      if (focusTimer) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        // snap: the desktop serializes this screen into snapshots ONLY while
        // our live byte stream is down (it is the fallback, not the feed)
        void sendCommand({ kind: 'session_focus', id: sessionId, text: JSON.stringify({ rows: term.rows, cols: term.cols, snap: !liveRef.current }) })
      }, 250)
    }
    const refit = () => {
      try { fit.fit(); term.scrollToBottom() } catch { /* mid-unmount */ }
      claimFocus()
    }
    claimRef.current = claimFocus
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(hostRef.current!)
    // touch scrolling: xterm's canvas eats the touches before its scrollable
    // viewport sees them, so vertical drags are translated ourselves. Pointer
    // Events (with capture) work on BOTH Android Chrome and iOS Safari (13+
    // honors touch-action: none for them).
    //
    // xterm can only scroll by whole rows, which on its own reads as a 14px
    // stutter. The fractional remainder is shown as a GPU translate of the
    // rendered screen, so the content tracks the finger pixel for pixel; whole
    // rows go to scrollLines. The fling is time-based (same feel at 60 and
    // 120 Hz) and settles onto a row boundary instead of stopping mid-row.
    const host = hostRef.current!
    const screenEl = () => host.querySelector('.xterm-screen') as HTMLElement | null
    const cellH = () => {
      const h = screenEl()?.clientHeight ?? 0
      return h > 0 && term.rows > 0 ? h / term.rows : 13.75
    }
    let tracking = false
    let lastY = 0
    let lastT = 0
    let carry = 0 // fractional lines not yet handed to xterm (-1, 1)
    let vel = 0 // smoothed velocity, lines per ms
    let raf = 0
    let frameT = 0
    let pendingFrac: number | null = null
    const setOffset = (frac: number) => {
      const el = screenEl()
      if (el) el.style.transform = frac ? `translate3d(0, ${(-frac * cellH()).toFixed(2)}px, 0)` : ''
    }
    // a whole-row scroll repaints on xterm's next frame: keep the old offset
    // until then, or the content jumps back a row for one frame
    const rendered = term.onRender(() => {
      if (pendingFrac !== null) { setOffset(pendingFrac); pendingFrac = null }
    })
    /** Move by `carry`: whole rows to xterm, the rest as a pixel offset,
     *  clamped at both ends of the buffer. Returns false at a hard edge. */
    const apply = (): boolean => {
      const buf = term.buffer.active
      const lines = carry > 0 ? Math.floor(carry) : Math.ceil(carry)
      let moved = false
      if (lines !== 0) {
        const before = buf.viewportY
        term.scrollLines(lines)
        moved = term.buffer.active.viewportY !== before
        carry -= lines
      }
      let edge = false
      const b = term.buffer.active
      if ((carry > 0 && b.viewportY >= b.baseY) || (carry < 0 && b.viewportY <= 0)) { carry = 0; edge = true }
      if (moved) pendingFrac = carry
      else setOffset(carry)
      return !edge
    }
    const flush = () => { raf = 0; apply() }
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush) }
    const settle = (t: number) => {
      raf = 0
      const dt = frameT ? Math.min(48, t - frameT) : 16.7
      frameT = t
      if (tracking) return
      if (Math.abs(vel) > 0.0015) {
        carry += vel * dt
        vel *= Math.pow(0.95, dt / 16.7)
        if (!apply()) vel = 0
        raf = requestAnimationFrame(settle)
        return
      }
      // coast onto the nearest row so text never rests half-cut
      vel = 0
      const target = Math.round(carry)
      const diff = target - carry
      if (Math.abs(diff) < 0.02) { carry = target; apply(); return }
      carry += diff * Math.min(1, dt / 60)
      apply()
      raf = requestAnimationFrame(settle)
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return // desktop keeps native wheel/select
      if (raf) { cancelAnimationFrame(raf); raf = 0 } // grab a live fling
      tracking = true
      lastY = e.clientY
      lastT = e.timeStamp
      vel = 0
      try { host.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    }
    const onMove = (e: PointerEvent) => {
      if (!tracking) return
      const dLines = (lastY - e.clientY) / cellH()
      const dt = e.timeStamp - lastT
      if (dt > 0) vel = 0.7 * vel + 0.3 * (dLines / dt)
      carry += dLines
      lastY = e.clientY
      lastT = e.timeStamp
      queue()
    }
    const onUp = (e: PointerEvent) => {
      if (!tracking) return
      tracking = false
      // a pause before lifting means "hold", not "fling"
      if (e.timeStamp - lastT > 80) vel = 0
      if (raf) cancelAnimationFrame(raf)
      frameT = 0
      raf = requestAnimationFrame(settle)
    }
    // belt for older iOS: keep the browser from rubber-banding the page
    const onTouchMove = (e: TouchEvent) => e.preventDefault()
    /** live output snapped the view to the bottom: drop any partial offset */
    resetScrollRef.current = () => {
      if (tracking) return
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      vel = 0
      carry = 0
      pendingFrac = null
      setOffset(0)
    }
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
      if (raf) cancelAnimationFrame(raf)
      rendered.dispose()
      resetScrollRef.current = () => {}
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
    // the first live chunk replays the tap's ring backlog — clear whatever the
    // snapshot fallback painted meanwhile, atomically with the backlog itself
    let fresh = true
    try {
      es = new EventSource(apiUrl('/api/term', { d: deviceToken(), id: sessionId }))
      es.onmessage = e => {
        const term = termRef.current
        if (!term || !e.data) return
        // stick to the bottom only when the user is already there — scrolling
        // back through history must not get yanked down by live output
        const buf = term.buffer.active
        const wasAtBottom = fresh || buf.viewportY >= buf.baseY
        if (fresh) { fresh = false; lastRef.current = ''; term.write('\x1bc') }
        term.write(b64Bytes(String(e.data)), () => {
          if (wasAtBottom) { term.scrollToBottom(); resetScrollRef.current() }
        })
      }
      es.onerror = () => { es?.close(); setLive(false) } // fall back to snapshots
    } catch {
      setLive(false)
    }
    return () => es?.close()
  }, [live, sessionId])

  // tell the desktop whether it needs to ship our screen in snapshots
  useEffect(() => { claimRef.current() }, [live])

  // a dropped live stream falls back to snapshots but keeps retrying — one
  // transient blip must not lock the view into flicker-prone full repaints
  useEffect(() => {
    if (live) return
    const t = setTimeout(() => setLive(true), 8000)
    return () => clearTimeout(t)
  }, [live])

  // snapshot fallback: replay the serialized buffer whenever it changes
  useEffect(() => {
    const term = termRef.current
    if (!term || live || data === lastRef.current) return
    lastRef.current = data
    // repaint atomically: reset + rewrite in ONE parsed chunk, guarded by DEC
    // 2026 synchronized updates, so the renderer never shows the blank frame
    // that term.reset() + a separate async write used to flash on every push
    const buf = term.buffer.active
    const fromBottom = buf.baseY - buf.viewportY
    term.write('\x1bc\x1b[?2026h' + data + '\x1b[?2026l', () => {
      // keep the reading position when the user has scrolled back
      term.scrollToLine(Math.max(0, term.buffer.active.baseY - fromBottom))
    })
  }, [data, live])

  return <div className="termfill"><div ref={hostRef} className="termfill-inner" /></div>
})
