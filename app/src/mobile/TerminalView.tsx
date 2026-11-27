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
import { useReclaim } from './reclaim'

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
const BASE_FONT = 11
const LINE_HEIGHT = 1.25
const MIRROR_KEY = 'yaam-remote-term-mirror'
function savedMirror(): boolean {
  try { return localStorage.getItem(MIRROR_KEY) === '1' } catch { return false }
}

/** `cols`/`rows` are the desktop terminal's size from the snapshot. In FIT
 *  mode the phone claims the PTY at its own size (reflowed for the phone, but
 *  the desktop pane shrinks with it). In MIRROR mode the phone adopts the
 *  desktop's size and pans sideways, so watching never disturbs the desktop
 *  layout or the TUI running in it. */
export const TerminalView = memo(function TerminalView({ sessionId, data, cols, rows, appScroll }: {
  sessionId: string; data: string; cols: number; rows?: number
  /** from the desktop: a full-screen TUI / mouse-reporting app, which has no
   *  scrollback here; a drag asks the app itself to scroll */
  appScroll?: 'mouse' | 'keys'
}) {
  const appScrollRef = useRef(appScroll)
  appScrollRef.current = appScroll
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const lastRef = useRef<string>('')
  const [live, setLive] = useState(true)
  const liveRef = useRef(live)
  liveRef.current = live
  const resetScrollRef = useRef<() => void>(() => {})
  // a finger is down or a fling is running: live output must not yank the
  // view to the bottom under it
  const gestureRef = useRef(false)
  const claimRef = useRef<() => void>(() => {})
  const refitRef = useRef<() => void>(() => {})
  const [mirror, setMirrorState] = useState(savedMirror)
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
  const dimsRef = useRef({ cols, rows })
  dimsRef.current = { cols, rows }
  const setMirror = (v: boolean) => {
    setMirrorState(v)
    try { localStorage.setItem(MIRROR_KEY, v ? '1' : '0') } catch { /* private mode */ }
  }

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: BASE_FONT,
      lineHeight: LINE_HEIGHT,
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
        const snap = !liveRef.current
        const claim = mirrorRef.current ? { snap, mirror: true } : { rows: term.rows, cols: term.cols, snap }
        void sendCommand({ kind: 'session_focus', id: sessionId, text: JSON.stringify(claim) })
      }, 250)
    }
    // mirror mode: the screen is wider than the phone; a sideways drag pans it
    let panX = 0
    let fracY = 0
    const screenOf = () => hostRef.current?.querySelector('.xterm-screen') as HTMLElement | null
    // Layout metrics, measured on refit and at each touch start, never per
    // frame: paint() writes a transform, and reading clientHeight/offsetHeight
    // after that forced a synchronous layout on every move event and frame.
    const m = { el: null as HTMLElement | null, cell: 13.75, lift: 0, minPan: 0 }
    const measure = () => {
      const el = screenOf()
      const host = hostRef.current
      m.el = el
      if (!el || !host) return
      const h = el.clientHeight
      m.cell = h > 0 && term.rows > 0 ? h / term.rows : 13.75
      // a mirrored screen taller than the phone even at the smallest font
      // stays anchored to its bottom rows, where the prompt and cursor live
      m.lift = mirrorRef.current ? Math.min(0, host.clientHeight - el.offsetHeight) : 0
      m.minPan = Math.min(0, host.clientWidth - el.offsetWidth)
    }
    const paint = () => {
      const el = m.el
      if (!el) return
      const y = m.lift - fracY * m.cell
      el.style.transform = panX || y ? `translate3d(${panX.toFixed(1)}px, ${y.toFixed(2)}px, 0)` : ''
    }
    const minPan = () => m.minPan
    const clampPan = () => {
      const next = mirrorRef.current ? Math.max(minPan(), Math.min(0, panX)) : 0
      if (next !== panX) { panX = next; paint() }
    }
    const refit = () => {
      try {
        if (mirrorRef.current) {
          const d = dimsRef.current
          const c = Math.min(400, Math.max(20, d.cols || 80))
          const r = Math.min(120, Math.max(8, d.rows || term.rows))
          if (c !== term.cols || r !== term.rows) term.resize(c, r)
          // every desktop row has to be on screen (TUIs draw their input box
          // at the bottom): shrink the font until the rows fit the height
          const h = hostRef.current?.clientHeight ?? 0
          const size = h ? Math.max(7, Math.min(BASE_FONT, Math.floor(h / r / LINE_HEIGHT))) : BASE_FONT
          if (term.options.fontSize !== size) {
            term.options.fontSize = size
            // cell metrics settle next frame and xterm rounds row heights, so
            // measure and step down until the rows really fit
            const shrink = () => {
              const el = screenOf()
              const fs = term.options.fontSize ?? BASE_FONT
              if (mirrorRef.current && el && h && el.offsetHeight > h && fs > 7) {
                term.options.fontSize = fs - 1
                requestAnimationFrame(shrink)
                return
              }
              measure()
              clampPan()
              paint()
            }
            requestAnimationFrame(shrink)
          }
        } else {
          if (term.options.fontSize !== BASE_FONT) term.options.fontSize = BASE_FONT
          fit.fit()
        }
        term.scrollToBottom()
        measure()
        clampPan()
        paint()
      } catch { /* mid-unmount */ }
      claimFocus()
    }
    claimRef.current = claimFocus
    refitRef.current = refit
    refit()
    const ro = new ResizeObserver(refit)
    ro.observe(hostRef.current!)
    // Touch scrolling. xterm's canvas eats touches before its scrollable
    // viewport sees them, so vertical drags are handled here (Pointer Events
    // with capture: Android Chrome and iOS Safari 13+ both honor
    // touch-action: none for them).
    //
    // - Drag is 1:1 with the finger. xterm scrolls by whole rows; the
    //   fractional remainder is a GPU translate of the rendered screen, so
    //   the content tracks the finger pixel for pixel.
    // - Release velocity comes from the finger's last ~80ms of samples
    //   (coalesced events included), not a per-event average, which
    //   under-read quick flicks; a finger that stopped before lifting does
    //   not fling.
    // - The fling decays like iOS scroll views (0.998 per ms, ~500ms time
    //   constant; it used to die at ~325ms), time-based so 60 and 120Hz feel
    //   the same, and settles onto a row boundary.
    // - Full-screen TUIs (no scrollback of their own) get the same gesture:
    //   rows go to the app as session_scroll, one request in flight at a
    //   time with movement merged meanwhile, plus momentum after a flick.
    const host = hostRef.current!
    const DECEL = 0.998 // velocity kept per ms
    const MAX_V = 7 // px per ms
    let tracking = false
    let axis: 'x' | 'y' | null = null
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let carry = 0 // fractional lines not yet handed to xterm (-1, 1)
    let vel = 0 // lines per ms (positive: toward the bottom)
    let raf = 0
    let frameT = 0
    let pendingFrac: number | null = null
    const samples: { t: number; y: number }[] = []
    const sample = (t: number, y: number) => {
      samples.push({ t, y })
      while (samples.length > 2 && t - samples[0].t > 120) samples.shift()
    }
    /** finger speed at release, px/ms, positive = finger moving up */
    const releaseSpeed = (now: number): number => {
      const last = samples[samples.length - 1]
      if (!last || now - last.t > 60) return 0 // held still before lifting
      const first = samples.find(x => last.t - x.t <= 90) ?? samples[0]
      const dt = last.t - first.t
      if (dt < 10) return 0
      return Math.max(-MAX_V, Math.min(MAX_V, (first.y - last.y) / dt))
    }
    // App scrolling. A full-screen TUI lives in the alternate buffer, which
    // has no scrollback: on the desktop it is the APP that scrolls, fed wheel
    // reports or arrow keys by xterm. Rows go to the desktop, which encodes
    // them exactly as its own xterm would.
    const appMode = (): 'mouse' | 'keys' | null => {
      if (appScrollRef.current) return appScrollRef.current
      // our own copy of the stream is a fallback hint (an older desktop)
      if (term.modes.mouseTrackingMode !== 'none') return 'mouse'
      return term.buffer.active.type === 'alternate' ? 'keys' : null
    }
    // At most ONE scroll request in flight. Movement made meanwhile is merged
    // into the next request when it returns, so updates pace themselves to
    // the network: firing every 35ms regardless queued requests behind the
    // browser's per-host connection limit over a slow link, and the app only
    // caught up after the finger had lifted. There is no fake preview offset:
    // the screen moves when the app redraws (a preview "acknowledged" by every
    // spinner redraw jagged the whole screen up and down).
    let appAcc = 0 // app steps not yet sent
    let appBusy = false
    const sendAppScroll = () => {
      if (appBusy) return
      const n = Math.trunc(appAcc)
      if (!n) return
      appAcc -= n
      appBusy = true
      sendCommand({ kind: 'session_scroll', id: sessionId, text: String(n) })
        .catch(() => {})
        .finally(() => {
          appBusy = false
          if (Math.abs(appAcc) >= 1) sendAppScroll()
        })
    }
    const pushApp = (dRows: number) => {
      // a wheel report scrolls most TUIs ~3 lines; an arrow key, one
      appAcc += dRows / (appMode() === 'mouse' ? 3 : 1)
      if (Math.abs(appAcc) >= 1) sendAppScroll()
    }
    let appFlingRows = 0
    const setOffset = (frac: number) => { fracY = frac; paint() }
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
    const stopped = () => Math.abs(vel) * m.cell < 0.02 // px/ms
    const settle = (t: number) => {
      raf = 0
      const dt = frameT ? Math.min(40, t - frameT) : 16.7
      frameT = t
      if (tracking) return
      if (!stopped()) {
        carry += vel * dt
        vel *= Math.pow(DECEL, dt)
        if (!apply()) vel = 0
        raf = requestAnimationFrame(settle)
        return
      }
      // coast onto the nearest row so text never rests half-cut
      vel = 0
      const target = Math.round(carry)
      const diff = target - carry
      if (Math.abs(diff) < 0.02) { carry = target; apply(); gestureRef.current = false; return }
      carry += diff * Math.min(1, dt / 70)
      apply()
      raf = requestAnimationFrame(settle)
    }
    const appFling = (t: number) => {
      raf = 0
      const dt = frameT ? Math.min(40, t - frameT) : 16.7
      frameT = t
      if (tracking) return
      // every app step is a network round trip: end the tail sooner than a
      // local fling (below ~1 row per 100ms it reads as stopped anyway)
      if (Math.abs(vel) * m.cell < 0.15 || appFlingRows > 60) { vel = 0; gestureRef.current = false; return }
      const d = vel * dt
      appFlingRows += Math.abs(d)
      pushApp(d)
      vel *= Math.pow(DECEL, dt)
      raf = requestAnimationFrame(appFling)
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return // desktop keeps native wheel/select
      if (raf) { cancelAnimationFrame(raf); raf = 0 } // grab a live fling
      measure() // once per gesture: cell size and pan bounds
      tracking = true
      gestureRef.current = true
      axis = null
      startX = lastX = e.clientX
      startY = e.clientY
      lastY = e.clientY
      vel = 0
      samples.length = 0
      sample(e.timeStamp, e.clientY)
      try { host.setPointerCapture(e.pointerId) } catch { /* unsupported */ }
    }
    const onMove = (e: PointerEvent) => {
      if (!tracking) return
      // high-rate touch screens deliver several positions per event: they all
      // feed the velocity estimate
      const points = e.getCoalescedEvents?.() ?? []
      for (const p of points.length ? points : [e]) sample(p.timeStamp, p.clientY)
      // lock to the dominant axis once the finger has clearly moved; only a
      // mirrored (wider than the phone) screen pans sideways
      if (!axis) {
        const ax = Math.abs(e.clientX - startX)
        const ay = Math.abs(e.clientY - startY)
        if (ax < 6 && ay < 6) return
        axis = mirrorRef.current && ax > ay ? 'x' : 'y'
      }
      if (axis === 'x') {
        panX = Math.max(minPan(), Math.min(0, panX + (e.clientX - lastX)))
        lastX = e.clientX
        paint()
        return
      }
      const dLines = (lastY - e.clientY) / m.cell
      lastY = e.clientY
      if (appMode()) { pushApp(dLines); return }
      carry += dLines
      queue()
    }
    const onUp = (e: PointerEvent) => {
      if (!tracking) return
      tracking = false
      if (axis !== 'y') { gestureRef.current = false; return }
      vel = releaseSpeed(e.timeStamp) / m.cell
      if (raf) cancelAnimationFrame(raf)
      frameT = 0
      if (appMode()) {
        appFlingRows = 0
        if (stopped()) { vel = 0; gestureRef.current = false; return }
        raf = requestAnimationFrame(appFling)
        return
      }
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
        const wasAtBottom = fresh || (buf.viewportY >= buf.baseY && !gestureRef.current)
        if (fresh) { fresh = false; lastRef.current = ''; term.write('\x1bc') }
        term.write(b64Bytes(String(e.data)), () => {
          if (wasAtBottom && !gestureRef.current) { term.scrollToBottom(); resetScrollRef.current() }
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
  useReclaim(() => claimRef.current())

  // switching fit/mirror re-lays out here and re-claims (mirror hands the
  // desktop its size back); in mirror, follow the desktop's size as it changes
  useEffect(() => { refitRef.current() }, [mirror])
  useEffect(() => { if (mirrorRef.current) refitRef.current() }, [cols, rows])

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
      if (!gestureRef.current) term.scrollToLine(Math.max(0, term.buffer.active.baseY - fromBottom))
    })
  }, [data, live])

  return (
    <div className="termfill">
      <div ref={hostRef} className="termfill-inner" />
      <button
        className={`termmode${mirror ? ' on' : ''}`}
        onClick={() => setMirror(!mirror)}
        title={mirror ? 'Mirroring the desktop layout (drag sideways to pan). Tap to fit this screen instead.' : 'Fitted to this phone (the desktop pane resizes too). Tap to mirror the desktop layout instead.'}
      >
        {mirror ? 'Mirror' : 'Fit'}
      </button>
    </div>
  )
})
