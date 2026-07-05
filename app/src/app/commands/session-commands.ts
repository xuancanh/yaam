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

export interface SessionCommandDeps {
  stateRef: MutableRefObject<AppState>
  port?: SessionProcessPort
}

export function registerSessionCommands(registry: CommandRegistry, deps: SessionCommandDeps): void {
  const port = deps.port ?? realSessionProcessPort
  registry.register<SendToSessionInput, void>({
    name: 'send_to_session',
    capability: 'sessions:send',
    validate: i => { if (!i.sessionId) throw new Error('send_to_session: sessionId is required') },
    handler: i => {
      // ignore writes to sessions that no longer exist (they may have exited)
      if (deps.stateRef.current.agents.some(a => a.id === i.sessionId)) {
        port.sendLine(i.sessionId, String(i.text))
      }
    },
  })
}
