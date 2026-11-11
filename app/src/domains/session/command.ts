// Session command helpers: agent-type resolution, env prefixing, native process
// spawn, key map, and TUI-safe line sending.
import * as native from '../../core/native'
import { binOf } from '../../core/agent-adapters'
import { useAppStore } from '../../core/store'
import { bracketedPasteOn } from '../../core/terminals'
import type { AppState } from '../../core/types'

/** Resolve a configured agent type from the executable at the start of a command. */
export function typeForCommand(command: string, types: AppState['agentTypes']) {
  // basename match, so `/usr/local/bin/claude` still resolves the claude type
  const bin = binOf(command)
  return bin ? types.find(t => binOf(t.model) === bin) : undefined
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
      const value = l.slice(i + 1)
      // a bare reference ($NAME / ${NAME}) expands in the login shell, so a
      // secret can live in the user's profile instead of persisted app state
      const ref = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value)
      if (ref) return `${l.slice(0, i)}="$${ref[1] ?? ref[2]}"`
      return `${l.slice(0, i)}='${value.replace(/'/g, `'\\''`)}'`
    })
  return parts.length ? `${parts.join(' ')} ` : ''
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
/** Send a prompt that may span lines. With bracketed paste on, the body goes
 *  in as one paste so embedded newlines don't submit early; without it, the
 *  lines are joined (a raw newline would submit each line on its own). */
export function sendPromptToSession(id: string, text: string) {
  const agent = useAppStore.getState().agents.find(a => a.id === id)
  if (agent?.acp || !text.includes('\n')) { sendLineToSession(id, text); return }
  if (bracketedPasteOn(id)) {
    native.writeSession(id, `\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`).catch(() => {})
    window.setTimeout(() => { native.writeSession(id, '\r').catch(() => {}) }, 350)
    return
  }
  sendLineToSession(id, text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join(' '))
}

export function sendLineToSession(id: string, text: string) {
  // ACP sessions have no PTY — a sent line IS the next prompt turn
  const agent = useAppStore.getState().agents.find(a => a.id === id)
  if (agent?.acp) {
    void native.acpPrompt(id, text)
    return
  }
  native.writeSession(id, text).catch(() => {})
  window.setTimeout(() => { native.writeSession(id, '\r').catch(() => {}) }, 250)
}
