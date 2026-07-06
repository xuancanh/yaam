// Capability ports for the session domain. The launch/exit runtimes and the
// session lifecycle actions drive the native PTY and the xterm terminal registry
// only through this narrow interface, so they never import core/native or
// core/terminals wholesale and can be tested with fakes. The real implementation
// wires the interface to the actual IPC and terminal registry; tests pass their own.
import * as native from '../../core/native'
import { fitTerminal, getTerminal, disposeTerminal, isAltScreen, quiesceTerminal, repaintSession, resetTerminal, restoreTerminalModes, terminalSize } from '../../core/terminals'
import { sendLineToSession } from './command'

/** A minimal handle to a session's terminal — just what callers need to write. */
export interface TerminalHandle {
  writeln: (text: string) => void
}

export interface SessionProcessPort {
  /** true when running inside the Tauri shell (CLI probing is a no-op otherwise) */
  readonly isTauri: boolean
  /** spawn the backend PTY for a session */
  spawnSession: (id: string, command: string, cwd?: string, rows?: number, cols?: number, terminalShell?: string, commandShell?: string) => Promise<void>
  /** kill a session's live PTY process */
  killSession: (id: string) => Promise<void>
  /** drop a session's persisted file */
  removeSession: (id: string) => Promise<void>
  /** write raw data to a session's PTY */
  writeSession: (id: string, data: string) => Promise<void>
  /** write a line + carriage return to a session (with the usual submit timing) */
  sendLine: (id: string, text: string) => void
  /** discover a CLI's resume id from its session files (best-effort) */
  detectCliSession: (kind: string, cwd: string | undefined, sinceMs: number, exclude?: string[]) => Promise<string | null>
  /** isolate a working folder in git worktree(s); returns where to run */
  createWorktree: (baseCwd: string, slug: string) => Promise<native.WorktreeInfo>
  /** start a detached host process; returns the attach command to spawn */
  detachedSpawn: (id: string, command: string, cwd?: string, commandShell?: string) => Promise<string>
  /** end a detached session for real */
  detachedKill: (id: string) => Promise<void>
  /** create (or reuse) the xterm terminal for a session and wire its callbacks */
  attachTerminal: (
    id: string,
    onPlainLine: (line: string) => void,
    onUserInput: () => void,
    onActivity: () => void,
    onUserSubmit: () => void,
  ) => TerminalHandle
  /** free a session's xterm buffer */
  disposeTerminal: (id: string) => void
  /** undo modes a dead TUI left behind (alt screen, mouse, …); keeps scrollback */
  restoreTerminalModes: (id: string) => void
  /** exit-time rest: restore modes, then hide/stop the cursor (dead session) */
  quiesceTerminal: (id: string) => void
  /** size the PTY to the pane and nudge the app to repaint (two-step resize) */
  repaintTerminal: (id: string) => void
  /** the pane's current terminal dimensions, for spawning at the right size */
  terminalSize: (id: string) => { rows: number; cols: number } | null
  /** full xterm reset (modes + buffers + scrollback) */
  resetTerminal: (id: string) => void
  /** true while the terminal is stuck in the alternate screen (dead TUI) */
  isAltScreen: (id: string) => boolean
}

export const realSessionProcessPort: SessionProcessPort = {
  isTauri: native.isTauri,
  spawnSession: (id, command, cwd, rows, cols, terminalShell, commandShell) => native.spawnSession(id, command, cwd, rows, cols, terminalShell, commandShell),
  killSession: id => native.killSession(id),
  removeSession: id => native.removeSession(id),
  writeSession: (id, data) => native.writeSession(id, data),
  sendLine: (id, text) => sendLineToSession(id, text),
  detectCliSession: (kind, cwd, sinceMs, exclude) => native.detectCliSession(kind, cwd, sinceMs, exclude),
  createWorktree: (baseCwd, slug) => native.worktreeCreate(baseCwd, slug),
  detachedSpawn: (id, command, cwd, commandShell) => native.detachedSpawn(id, command, cwd, commandShell),
  detachedKill: id => native.detachedKill(id),
  attachTerminal: (id, onPlainLine, onUserInput, onActivity, onUserSubmit) => {
    const { term } = getTerminal(id, onPlainLine, onUserInput, onActivity, onUserSubmit)
    return { writeln: text => term.writeln(text) }
  },
  disposeTerminal: id => disposeTerminal(id),
  restoreTerminalModes: id => restoreTerminalModes(id),
  quiesceTerminal: id => quiesceTerminal(id),
  repaintTerminal: id => { fitTerminal(id); repaintSession(id) },
  terminalSize: id => terminalSize(id),
  resetTerminal: id => resetTerminal(id),
  isAltScreen: id => isAltScreen(id),
}
