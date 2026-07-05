// Capability ports for the session domain. The launch/exit runtimes drive the
// native PTY and the xterm terminal registry only through this narrow interface,
// so they never import core/native or core/terminals wholesale and can be tested
// with fakes. The real implementation wires the interface to the actual IPC and
// terminal registry; tests pass their own.
import * as native from '../../core/native'
import { getTerminal } from '../../core/terminals'

export interface SessionProcessPort {
  /** true when running inside the Tauri shell (CLI probing is a no-op otherwise) */
  readonly isTauri: boolean
  /** spawn the backend PTY for a session */
  spawnSession: (id: string, command: string, cwd?: string, rows?: number, cols?: number, terminalShell?: string) => Promise<void>
  /** discover a CLI's resume id from its session files (best-effort) */
  detectCliSession: (kind: string, cwd: string | undefined, sinceMs: number, exclude?: string[]) => Promise<string | null>
  /** create (or reuse) the xterm terminal for a session and wire its callbacks */
  attachTerminal: (
    id: string,
    onPlainLine: (line: string) => void,
    onUserInput: () => void,
    onActivity: () => void,
    onUserSubmit: () => void,
  ) => void
}

export const realSessionProcessPort: SessionProcessPort = {
  isTauri: native.isTauri,
  spawnSession: (id, command, cwd, rows, cols, terminalShell) => native.spawnSession(id, command, cwd, rows, cols, terminalShell),
  detectCliSession: (kind, cwd, sinceMs, exclude) => native.detectCliSession(kind, cwd, sinceMs, exclude),
  attachTerminal: (id, onPlainLine, onUserInput, onActivity, onUserSubmit) => {
    getTerminal(id, onPlainLine, onUserInput, onActivity, onUserSubmit)
  },
}
