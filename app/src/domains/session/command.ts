// Session command helpers: agent-type resolution, env prefixing, native process
// spawn, key map, and TUI-safe line sending.
import * as native from '../../core/native'
import type { AppState } from '../../core/types'

/** Resolve a configured agent type from the executable at the start of a command. */
export function typeForCommand(command: string, types: AppState['agentTypes']) {
  const bin = command.trim().split(/\s+/)[0]
  return types.find(t => t.model.trim().split(/\s+/)[0] === bin)
}

// KEY=value lines → shell assignment prefix (we spawn via sh -lc)
/** Convert newline-delimited environment assignments into a shell-safe prefix. */
export function envPrefix(env?: string): string {
  if (!env) return ''
  const parts = env.split('\n')
    .map(l => l.trim())
    .filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map(l => {
      const i = l.indexOf('=')
      return `${l.slice(0, i)}='${l.slice(i + 1).replace(/'/g, `'\\''`)}'`
    })
  return parts.length ? `${parts.join(' ')} ` : ''
}

/** Launch a command or persisted direct terminal shell through the native bridge. */
export function spawnAgentProcess(id: string, command: string, cwd?: string, terminalShell?: string): Promise<void> {
  return native.spawnSession(id, command.trim(), cwd || undefined, undefined, undefined, terminalShell)
}

/** Resolve after a browser timer delay. */
export const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

export const KEYMAP: Record<string, string> = {
  enter: '\r', esc: '\x1b', escape: '\x1b', up: '\x1b[A', down: '\x1b[B',
  right: '\x1b[C', left: '\x1b[D', tab: '\t', space: ' ', backspace: '\x7f',
  'ctrl+c': '\x03', 'ctrl+d': '\x04',
}

/** Send text and Enter as separate writes; TUIs otherwise treat the combined
 *  chunk as pasted text and may insert a newline instead of submitting. */
export function sendLineToSession(id: string, text: string) {
  native.writeSession(id, text).catch(() => {})
  window.setTimeout(() => { native.writeSession(id, '\r').catch(() => {}) }, 250)
}
