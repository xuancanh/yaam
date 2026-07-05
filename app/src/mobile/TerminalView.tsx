// Real terminal rendering for the companion: the SAME xterm.js the desktop
// uses. Preferred source is the LIVE raw-byte SSE stream served straight from
// the Rust PTY reader (multi-device sync independent of the desktop webview);
// when the stream is unavailable it falls back to replaying the serialized
// buffer from the snapshot. Fixed source column count — the host scrolls
// horizontally instead of rewrapping TUI layouts.
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
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

export function TerminalView({ sessionId, data, cols }: { sessionId: string; data: string; cols: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const lastRef = useRef<string>('')
  const colsRef = useRef<number>(0)
  const [live, setLive] = useState(true)

  useEffect(() => {
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      lineHeight: 1.2,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      scrollback: 400,
      theme: THEME,
    })
    term.open(hostRef.current!)
    termRef.current = term
    return () => {
      term.dispose()
      termRef.current = null
      lastRef.current = ''
      colsRef.current = 0
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
    if (!term) return
    const wantCols = Math.max(20, cols || 80)
    if (colsRef.current !== wantCols) {
      colsRef.current = wantCols
      term.resize(wantCols, 36)
    }
    if (live || data === lastRef.current) return
    lastRef.current = data
    term.reset()
    term.write(data, () => term.scrollToBottom())
  }, [data, cols, live])

  return (
    <div className="termscroll">
      <div ref={hostRef} className="termhost" />
    </div>
  )
}
