// Real terminal rendering for the companion: the SAME xterm.js the desktop
// uses. Preferred source is the LIVE raw-byte SSE stream served straight from
// the Rust PTY reader; fallback is replaying the serialized snapshot buffer.
// The terminal FITS its container (FitAddon + ResizeObserver) so lines wrap to
// the phone's width and the PTY-side layout reflows readably.
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { apiUrl, deviceToken } from './api'

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
    try { fit.fit() } catch { /* not laid out yet */ }
    termRef.current = term
    const ro = new ResizeObserver(() => {
      try { fit.fit(); term.scrollToBottom() } catch { /* mid-unmount */ }
    })
    ro.observe(hostRef.current!)
    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      lastRef.current = ''
    }
  }, [])

  // live mode: raw PTY bytes over SSE, straight from the Rust session tap
  useEffect(() => {
    if (!live) return
    let es: EventSource | null = null
    try {
      es = new EventSource(apiUrl('/api/term', { d: deviceToken(), id: sessionId }))
      es.onmessage = e => {
        const term = termRef.current
        if (!term || !e.data) return
        term.write(b64Bytes(String(e.data)), () => term.scrollToBottom())
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
