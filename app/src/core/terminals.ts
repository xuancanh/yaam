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
  /** Enter pressed — the user submitted something to the session */
  onUserSubmit: (() => void) | null
  /** called on every raw output chunk — TUI redraws often contain no newlines */
  onActivity: (() => void) | null
  pending: string
  /** per-session streaming decoder — partial UTF-8 must not mix across PTYs */
  decoder: TextDecoder
}

const entries = new Map<string, Entry>()

// ── theme-aware terminal palettes ────────────────────────────────────────────
// xterm paints to canvas, so CSS variables don't resolve — each app theme
// carries a literal ANSI palette. Dark/midnight share the dark palette; light
// and paper get legible-on-light colors.

const DARK_TERM = {
  background: '#0A0B0F', foreground: '#C7CCD6', cursor: '#F5C451',
  selectionBackground: 'rgba(245,196,81,.28)',
  black: '#1a1e26', red: '#FF7A7A', green: '#3DDC97', yellow: '#F5C451',
  blue: '#7FD1FF', magenta: '#C77DFF', cyan: '#7FE3B0', white: '#E7E9F0',
  brightBlack: '#4a5262', brightRed: '#FF9B9B', brightGreen: '#7FE3B0',
  brightYellow: '#FFD98A', brightBlue: '#A8DFFF', brightMagenta: '#DCA9FF',
  brightCyan: '#A5F0CC', brightWhite: '#FFFFFF',
}

const LIGHT_TERM = {
  background: '#FAFBFC', foreground: '#24292F', cursor: '#B07D10',
  selectionBackground: 'rgba(176,125,16,.25)',
  black: '#24292F', red: '#C62828', green: '#1A7F37', yellow: '#9A6700',
  blue: '#0550AE', magenta: '#8250DF', cyan: '#1B7C83', white: '#8C959F',
  brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#2DA44E',
  brightYellow: '#7D4E00', brightBlue: '#218BFF', brightMagenta: '#A475F9',
  brightCyan: '#3192AA', brightWhite: '#6E7781',
}

const PAPER_TERM = {
  ...LIGHT_TERM,
  background: '#F4EFE4', foreground: '#3A342A', cursor: '#8A6D1F',
  selectionBackground: 'rgba(138,109,31,.22)',
  black: '#3A342A', white: '#8A8069', brightWhite: '#6E6553',
}

/** Literal xterm palette for one app theme (pure — unit-testable). */
export function termThemeFor(theme: string): typeof DARK_TERM {
  if (theme === 'light') return LIGHT_TERM
  if (theme === 'paper') return PAPER_TERM
  return DARK_TERM // dark + midnight
}

/** The theme currently stamped on <html> by the appearance system. */
function currentAppTheme(): string {
  return typeof document !== 'undefined'
    ? document.documentElement.getAttribute('data-theme') ?? 'dark'
    : 'dark'
}

/** Repaint every open terminal for a theme change (xterm ignores CSS vars). */
export function applyTerminalTheme(theme: string) {
  const palette = termThemeFor(theme)
  for (const entry of entries.values()) entry.term.options.theme = palette
}
let listenerStarted = false

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

/** Install the single native-data listener that routes PTY bytes to registered terminals. */
function ensureListener() {
  if (listenerStarted) return
  listenerStarted = true
  onSessionData(e => {
    const entry = entries.get(e.id)
    if (!entry) return
    entry.term.write(e.bytes)
    entry.onActivity?.()
    if (entry.onPlainLine) {
      entry.pending += entry.decoder.decode(e.bytes, { stream: true })
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

/** Return an existing terminal or create and wire one for a session id. */
export function getTerminal(
  id: string,
  onPlainLine?: (line: string) => void,
  onUserInput?: () => void,
  onActivity?: () => void,
  onUserSubmit?: () => void,
): Entry {
  ensureListener()
  let entry = entries.get(id)
  if (!entry) {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: termThemeFor(currentAppTheme()),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.onData(data => {
      // scroll/mouse/arrow escape sequences are not the user answering a prompt
      if (!data.startsWith('\x1b[')) {
        const entry = entries.get(id)
        entry?.onUserInput?.()
        if (data.includes('\r') || data.includes('\n')) entry?.onUserSubmit?.()
      }
      writeSession(id, data).catch(() => {})
    })
    entry = { term, fit, onPlainLine: onPlainLine ?? null, onUserInput: onUserInput ?? null, onActivity: onActivity ?? null, onUserSubmit: onUserSubmit ?? null, pending: '', decoder: new TextDecoder() }
    entries.set(id, entry)
  } else {
    if (onPlainLine) entry.onPlainLine = onPlainLine
    if (onUserInput) entry.onUserInput = onUserInput
    if (onActivity) entry.onActivity = onActivity
    if (onUserSubmit) entry.onUserSubmit = onUserSubmit
  }
  return entry
}

/** Read the currently rendered screen as normalized, non-empty visible rows. */
export function readScreen(id: string, maxRows = 30): string[] {
  const entry = entries.get(id)
  if (!entry) return []
  const buf = entry.term.buffer.active
  const lines: string[] = []
  const start = Math.max(0, buf.length - entry.term.rows)
  for (let y = start; y < buf.length; y++) {
    const l = buf.getLine(y)
    if (!l) continue
    const txt = l.translateToString(true).trimEnd()
    if (txt) lines.push(txt)
  }
  return lines.slice(-maxRows)
}

/** Report whether the session is showing a full-screen TUI buffer. */
export function isAltScreen(id: string): boolean {
  return entries.get(id)?.term.buffer.active.type === 'alternate'
}

/** Fit xterm to its container and propagate the resulting size to the PTY. */
export function fitTerminal(id: string) {
  const entry = entries.get(id)
  if (!entry || !entry.term.element) return
  // a mid-unmount ResizeObserver tick measures 0 height — fitting then would
  // clamp the terminal to one row and wreck the viewport (measure the host
  // container: the xterm element itself sizes from the last fit)
  const host = entry.term.element.parentElement
  if (host && !host.clientHeight) return
  try {
    entry.fit.fit()
    resizeSession(id, entry.term.rows, entry.term.cols)
  } catch { /* pane not laid out yet */ }
}

/**
 * Force a running TUI to repaint with two SIGWINCHes after its pane remounts;
 * resizing is safe where injecting replayed terminal text would corrupt it.
 */
export function repaintSession(id: string) {
  const entry = entries.get(id)
  if (!entry || !entry.term.element) return
  const { rows, cols } = entry.term
  resizeSession(id, rows, Math.max(2, cols - 1)).then(() => {
    window.setTimeout(() => { resizeSession(id, rows, cols).catch(() => {}) }, 140)
  }).catch(() => {})
}

// A TUI killed mid-render (Ctrl+C, crash) never restores the terminal: the
// xterm stays in the alternate screen with mouse tracking, bracketed paste,
// application cursor keys, and a hidden cursor — which reads as "frozen /
// corrupted". These sequences undo those modes WITHOUT clearing the main
// buffer, so the session's scrollback survives.
const MODE_RESTORE =
  '\x1b[?1049l\x1b[?47l' + // leave the alternate screen (both variants)
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' + // mouse tracking off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1l' + // application cursor keys off
  '\x1b[?25h' + // cursor visible
  '\x1b[0m' // SGR attributes reset

/** Undo the terminal modes a dead process left behind (scrollback kept). */
export function restoreTerminalModes(id: string) {
  entries.get(id)?.term.write(MODE_RESTORE)
}

/** Full xterm reset (modes + buffers) — the clean slate before a respawn
 *  reuses this terminal (resume), so the new process never inherits state. */
export function resetTerminal(id: string) {
  entries.get(id)?.term.reset()
}

/** Dispose xterm resources and remove a session from the module registry. */
export function disposeTerminal(id: string) {
  const entry = entries.get(id)
  if (entry) {
    entry.term.dispose()
    entries.delete(id)
  }
}
