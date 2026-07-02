// One xterm.js Terminal per session, kept alive across pane mounts so the
// scrollback survives tab switches. Raw PTY bytes fan out from a single
// session-data listener; keystrokes go straight back to the PTY.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { onSessionData, resizeSession, writeSession } from './native'

interface Entry {
  term: Terminal
  fit: FitAddon
  onPlainLine: ((line: string) => void) | null
  onUserInput: (() => void) | null
  pending: string
}

const entries = new Map<string, Entry>()
let listenerStarted = false
const decoder = new TextDecoder()

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

function ensureListener() {
  if (listenerStarted) return
  listenerStarted = true
  onSessionData(e => {
    const entry = entries.get(e.id)
    if (!entry) return
    entry.term.write(e.bytes)
    if (entry.onPlainLine) {
      entry.pending += decoder.decode(e.bytes, { stream: true })
      const parts = entry.pending.split(/\r\n|\n|\r/)
      entry.pending = parts.pop() ?? ''
      for (const raw of parts) {
        const line = raw.replace(ANSI_RE, '').trimEnd()
        if (line) entry.onPlainLine(line)
      }
      if (entry.pending.length > 4000) entry.pending = entry.pending.slice(-2000)
    }
  })
}

export function getTerminal(id: string, onPlainLine?: (line: string) => void, onUserInput?: () => void): Entry {
  ensureListener()
  let entry = entries.get(id)
  if (!entry) {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0A0B0F',
        foreground: '#C7CCD6',
        cursor: '#F5C451',
        selectionBackground: 'rgba(245,196,81,.28)',
        black: '#1a1e26', red: '#FF7A7A', green: '#3DDC97', yellow: '#F5C451',
        blue: '#7FD1FF', magenta: '#C77DFF', cyan: '#7FE3B0', white: '#E7E9F0',
        brightBlack: '#4a5262', brightRed: '#FF9B9B', brightGreen: '#7FE3B0',
        brightYellow: '#FFD98A', brightBlue: '#A8DFFF', brightMagenta: '#DCA9FF',
        brightCyan: '#A5F0CC', brightWhite: '#FFFFFF',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.onData(data => {
      entries.get(id)?.onUserInput?.()
      writeSession(id, data).catch(() => {})
    })
    entry = { term, fit, onPlainLine: onPlainLine ?? null, onUserInput: onUserInput ?? null, pending: '' }
    entries.set(id, entry)
  } else {
    if (onPlainLine) entry.onPlainLine = onPlainLine
    if (onUserInput) entry.onUserInput = onUserInput
  }
  return entry
}

export function fitTerminal(id: string) {
  const entry = entries.get(id)
  if (!entry || !entry.term.element) return
  try {
    entry.fit.fit()
    resizeSession(id, entry.term.rows, entry.term.cols)
  } catch { /* pane not laid out yet */ }
}

export function disposeTerminal(id: string) {
  const entry = entries.get(id)
  if (entry) {
    entry.term.dispose()
    entries.delete(id)
  }
}
