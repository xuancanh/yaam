// Session domain commands registered on the application command registry. The
// canonical "type a line into a session's PTY" use case lives here once, gated by
// the sessions:send capability, so the UI, Master, and addons all reach the PTY
// through the same validated + policy-checked path instead of three ad-hoc calls.
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { SessionProcessPort } from '../../domains/session/ports'
import { realSessionProcessPort } from '../../domains/session/ports'
import type { CommandRegistry } from './registry'

export interface SendToSessionInput {
  sessionId: string
  text: string
}

export interface StopSessionInput {
  sessionId: string
}

export interface SessionCommandDeps {
  stateRef: MutableRefObject<AppState>
  /** record that this session's exit is a user-initiated stop, not a completion */
  markUserStopped: (id: string) => void
  port?: SessionProcessPort
}

export function registerSessionCommands(registry: CommandRegistry, deps: SessionCommandDeps): void {
  const port = deps.port ?? realSessionProcessPort
  const exists = (id: string) => deps.stateRef.current.agents.some(a => a.id === id)

  registry.register<SendToSessionInput, void>({
    name: 'send_to_session',
    capability: 'sessions:send',
    validate: i => { if (!i.sessionId) throw new Error('send_to_session: sessionId is required') },
    handler: i => {
      // ignore writes to sessions that no longer exist (they may have exited)
      if (exists(i.sessionId)) port.sendLine(i.sessionId, String(i.text))
    },
  })

  registry.register<StopSessionInput, void>({
    name: 'stop_session',
    capability: 'sessions:send',
    validate: i => { if (!i.sessionId) throw new Error('stop_session: sessionId is required') },
    handler: i => {
      if (!exists(i.sessionId)) return
      // flag the stop first so the exit handler treats it as a user stop, then kill
      deps.markUserStopped(i.sessionId)
      port.killSession(i.sessionId).catch(() => {})
    },
  })
}
