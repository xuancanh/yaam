// One xterm.js Terminal per session, kept alive across pane mounts so the
// scrollback survives tab switches. Raw PTY bytes fan out from a single
// session-data listener; keystrokes go straight back to the PTY.
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { onSessionData, openExternal, resizeSession, writeSession } from './native'
import { filePathMatches } from './terminal-links'
import { TerminalInputBuffer } from './terminal-input'

export interface Entry {
  term: Terminal
  fit: FitAddon
  /** lazily loaded — only when something (the mobile companion) serializes */
  serializer?: SerializeAddon
  /** lazily loaded — only when the pane opens the find bar */
  search?: SearchAddon
  /** GPU renderer, held only while the terminal's pane is mounted */
  gl?: WebglAddon
  onPlainLine: ((line: string) => void) | null
  onUserInput: (() => void) | null
  /** Enter pressed — the text reconstructed from user keystrokes is submitted */
  onUserSubmit: ((text: string) => void) | null
  input: TerminalInputBuffer
  /** called on every raw output chunk — TUI redraws often contain no newlines */
  onActivity: (() => void) | null
  /** the mounted pane's find bar opener (Cmd/Ctrl+F inside the terminal) */
  onSearchOpen: (() => void) | null
  /** the mounted pane's file-link handler (ctrl/cmd+click on a path) */
  onOpenFile: ((path: string) => void) | null
  /** the find bar's live match counter (search decorations changed) */
  onSearchResults: ((index: number, count: number) => void) | null
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
  onUserSubmit?: (text: string) => void,
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
    // ctrl/cmd+click a URL → default browser. Plain clicks fall through to the
    // terminal (TUIs get their mouse events; no accidental navigation).
    term.loadAddon(new WebLinksAddon((ev, uri) => {
      if (ev.ctrlKey || ev.metaKey) void openExternal(uri)
    }))
    // ctrl/cmd+click a file path → the session's Files viewer. The mounted
    // pane owns resolution (cwd join) via its onOpenFile callback.
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1)
        if (!line || line.isWrapped) return cb(undefined)
        const text = line.translateToString(true)
        cb(filePathMatches(text).map(match => ({
          range: { start: { x: match.index + 1, y }, end: { x: match.index + match.length, y } },
          text: text.slice(match.index, match.index + match.length),
          decorations: { pointerCursor: true, underline: true },
          activate(ev: MouseEvent) {
            if (ev.ctrlKey || ev.metaKey) entries.get(id)?.onOpenFile?.(match.path)
          },
        })))
      },
    })
    // Cmd+F (mac) / Ctrl+Shift+F opens the pane's find bar. Plain Ctrl+F must
    // keep reaching the shell (readline forward-char).
    term.attachCustomKeyEventHandler(ev => {
      const findKey = ev.key.toLowerCase() === 'f' && (ev.metaKey || (ev.ctrlKey && ev.shiftKey))
      if (ev.type === 'keydown' && findKey) {
        entries.get(id)?.onSearchOpen?.()
        return false
      }
      return true
    })
    term.onData(data => {
      const entry = entries.get(id)
      // scroll/mouse/arrow escape sequences are not the user answering a prompt
      if (!data.startsWith('\x1b[')) {
        entry?.onUserInput?.()
      }
      for (const text of entry?.input.feed(data) ?? []) entry?.onUserSubmit?.(text)
      writeSession(id, data).catch(() => {})
    })
    entry = { term, fit, onPlainLine: onPlainLine ?? null, onUserInput: onUserInput ?? null, onActivity: onActivity ?? null, onUserSubmit: onUserSubmit ?? null, input: new TerminalInputBuffer(), onSearchOpen: null, onOpenFile: null, onSearchResults: null, pending: '', decoder: new TextDecoder() }
    entries.set(id, entry)
  } else {
    if (onPlainLine) entry.onPlainLine = onPlainLine
    if (onUserInput) entry.onUserInput = onUserInput
    if (onActivity) entry.onActivity = onActivity
    if (onUserSubmit) entry.onUserSubmit = onUserSubmit
  }
  return entry
}

/** Switch a mounted terminal to the WebGL renderer. The DOM renderer re-lays
 *  out a span per row on every frame, which stutters under fast TUI output and
 *  competes with keystroke handling. Contexts are a browser-capped resource
 *  (~16), so panes enable this on mount and release it on unmount. */
export function enableGpuRenderer(id: string) {
  const entry = entries.get(id)
  if (!entry || entry.gl || !entry.term.element) return
  try {
    const gl = new WebglAddon()
    gl.onContextLoss(() => {
      gl.dispose()
      if (entry.gl === gl) entry.gl = undefined
    }) // xterm falls back to DOM; don't clear a replacement renderer
    entry.term.loadAddon(gl)
    entry.gl = gl
  } catch { /* no WebGL — DOM renderer still works */ }
}

/** Release a pane's WebGL context (pane unmounted; terminal stays alive). */
export function disableGpuRenderer(id: string) {
  const entry = entries.get(id)
  if (!entry?.gl) return
  try { entry.gl.dispose() } catch { /* already lost */ }
  entry.gl = undefined
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

/** A remote device takes terminal focus: size BOTH the desktop xterm and the
 *  PTY to the remote's dimensions so every device renders the same layout.
 *  The desktop steals focus back simply by fitting again (pane interaction,
 *  layout change, or an explicit remote blur). */
export function remoteResize(id: string, rows: number, cols: number) {
  const entry = entries.get(id)
  if (!entry) return
  const r = Math.min(120, Math.max(8, Math.round(rows)))
  const c = Math.min(400, Math.max(20, Math.round(cols)))
  try { entry.term.resize(c, r) } catch { /* not attached yet */ }
  resizeSession(id, r, c).catch(() => {})
}

/** Serialize a session's terminal buffer to ANSI text (colors, layout, and a
 *  bounded scrollback intact) so another xterm — the mobile companion's — can
 *  replay it pixel-faithfully. Empty string when the terminal doesn't exist. */
export function serializeScreen(id: string, scrollback = 80): string {
  const entry = entries.get(id)
  if (!entry) return ''
  if (!entry.serializer) {
    entry.serializer = new SerializeAddon()
    entry.term.loadAddon(entry.serializer)
  }
  try {
    return entry.serializer.serialize({ scrollback })
  } catch {
    return ''
  }
}

// ── find bar plumbing ────────────────────────────────────────────────────────

/** Lazily attach the search addon and forward its result counts. */
function ensureSearch(entry: Entry): SearchAddon {
  if (!entry.search) {
    entry.search = new SearchAddon()
    entry.term.loadAddon(entry.search)
    entry.search.onDidChangeResults(e => entry.onSearchResults?.(e.resultIndex, e.resultCount))
  }
  return entry.search
}

/** Match highlight colors per app theme (decorations need literal #RRGGBB). */
function searchDecorations(): { matchBackground: string; matchOverviewRuler: string; activeMatchBackground: string; activeMatchColorOverviewRuler: string } {
  const dark = !['light', 'paper'].includes(currentAppTheme())
  const match = dark ? '#5A4A18' : '#F0DFA8'
  const active = '#F5C451'
  return { matchBackground: match, matchOverviewRuler: match, activeMatchBackground: active, activeMatchColorOverviewRuler: active }
}

/** Find bar search: highlight all matches and move to the next/previous one.
 *  `incremental` keeps the active match while the query is being typed. */
export function findInTerminal(id: string, query: string, dir: 'next' | 'prev', incremental = false) {
  const entry = entries.get(id)
  if (!entry) return
  const search = ensureSearch(entry)
  if (!query) {
    search.clearDecorations()
    entry.onSearchResults?.(-1, 0)
    return
  }
  const opts = { decorations: searchDecorations(), incremental: dir === 'next' && incremental }
  if (dir === 'next') search.findNext(query, opts)
  else search.findPrevious(query, opts)
}

/** Close the find bar: drop highlights and the selection it left behind. */
export function clearTerminalSearch(id: string) {
  const entry = entries.get(id)
  entry?.search?.clearDecorations()
  entry?.term.clearSelection()
}

/** Open the mounted pane's find bar (the pane header's search button). */
export function openTerminalSearch(id: string) {
  entries.get(id)?.onSearchOpen?.()
}

/** Current xterm dimensions, so a respawn can open its PTY at the pane's real
 *  size instead of the backend's 24×80 default. */
export function terminalSize(id: string): { rows: number; cols: number } | null {
  const term = entries.get(id)?.term
  return term ? { rows: term.rows, cols: term.cols } : null
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
    const before = `${entry.term.rows}x${entry.term.cols}`
    entry.fit.fit()
    const changed = `${entry.term.rows}x${entry.term.cols}` !== before
    resizeSession(id, entry.term.rows, entry.term.cols)
    if (changed) {
      // A reflow invalidates any active selection's cell coordinates and can
      // leave the WebGL grid painted at the previous cell metrics — the symptom
      // being clicks/selection landing on the wrong glyph and typed input
      // appearing offset. Drop the stale selection and force a full repaint so
      // the renderer re-measures against the new size.
      entry.term.clearSelection()
      entry.term.refresh(0, entry.term.rows - 1)
    }
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
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' + // mouse tracking off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?1l' + // application cursor keys off
  '\x1b[?25h' + // cursor visible
  '\x1b[0m' // SGR attributes reset

/** Undo the terminal modes a dead process left behind (scrollback kept).
 *
 *  The alt-screen exit is deliberately conditional: xterm's `?1049l` handler
 *  "restores" the cursor even when nothing was ever saved, which lands at the
 *  top-left — the next process then overwrites (or clears) the preserved
 *  history from row 0, leaving a mostly blank screen with only its own last
 *  lines. So: leave the alt screen only when we are actually in it, and then
 *  re-park the cursor just below the last real content line so new output
 *  appends after the history. */
export function restoreTerminalModes(id: string) {
  const entry = entries.get(id)
  if (!entry) return
  const { term } = entry
  term.options.cursorBlink = true // revive a terminal quiesced by an earlier exit
  if (term.buffer.active.type !== 'alternate') {
    term.write(MODE_RESTORE) // modes only — the cursor is already where it belongs
    return
  }
  term.write('\x1b[?1049l\x1b[?47l' + MODE_RESTORE, () => {
    // the buffer switch has been processed — find where the normal-buffer
    // content actually ends and put the cursor on the line after it
    const buf = term.buffer.active
    let last = buf.length - 1
    while (last >= 0 && !(buf.getLine(last)?.translateToString(true) ?? '').trim()) last--
    const base = Math.max(0, buf.length - term.rows)
    const target = last - base + 2 // 1-based viewport row after the content
    if (target <= term.rows) term.write(`\x1b[${Math.max(1, target)};1H`)
    else term.write(`\x1b[${term.rows};1H\r\n`) // content fills the screen: scroll one line open
  })
}

/** Put a dead session's terminal to rest: normalize whatever modes the
 *  process left behind, then hide the cursor and stop it blinking — a paused
 *  session has nothing to type into, so a live cursor just reads as broken.
 *  restoreTerminalModes (the resume path) undoes this. */
export function quiesceTerminal(id: string) {
  const entry = entries.get(id)
  if (!entry) return
  restoreTerminalModes(id)
  entry.term.options.cursorBlink = false
  entry.term.write('\x1b[?25l')
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
