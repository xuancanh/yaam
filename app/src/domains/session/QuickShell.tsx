// Quick shell: a scratch terminal docked inside a session pane (the VS Code
// ⌘J panel). One PTY per host session, keyed `shell-<sessionId>` and owned by
// the shared terminal registry, so hiding the panel keeps the shell (and
// whatever it's running) alive; Restart in the dock strip respawns it fresh.
// Local sessions run the configured shell in the session's folder; remote
// (ssh) sessions open the login shell on the machine, in the same folder the
// Files/Changes panels browse.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConductorSelector } from '../../store'
import { killSession, liveSessions, spawnSession } from '../../core/native'
import { disposeTerminal, getTerminal } from '../../core/terminals'
import type { Agent } from '../../core/types'
import { TerminalPane } from './TerminalPane'
import { wrapLaunch } from './remote-machine'

/** PTY / terminal-registry id of a session's quick shell. */
export function quickShellId(agentId: string): string {
  return `shell-${agentId}`
}

/** Kill and forget a session's quick shell (archive/restart cleanup). */
export function disposeQuickShell(agentId: string): void {
  const id = quickShellId(agentId)
  void killSession(id).catch(() => {})
  disposeTerminal(id)
}

// toggle bus: each mounted pane registers its toggle so ⌘J and the command
// palette can flip the panel for the active session (same pattern as the
// open-file bus — panes own the panel state, outsiders only signal)
const toggles = new Map<string, () => void>()

export function onQuickShellToggle(agentId: string, fn: () => void): () => void {
  toggles.set(agentId, fn)
  return () => { if (toggles.get(agentId) === fn) toggles.delete(agentId) }
}

export function requestQuickShellToggle(agentId: string): void {
  toggles.get(agentId)?.()
}

export function QuickShell({ agent }: { agent: Agent }) {
  const id = quickShellId(agent.id)
  const shell = useConductorSelector(x => x.settings.shell) || 'zsh'
  const [state, setState] = useState<'starting' | 'ready' | 'failed'>('starting')
  const [err, setErr] = useState('')
  const startedRef = useRef(false)

  // the registry entry is shared with the agent's own terminal infrastructure;
  // a synthetic agent routes TerminalPane (fit, find bar, links) at the shell id
  const shellAgent = useMemo<Agent>(
    () => ({ ...agent, id, kind: 'real', name: `${agent.name} · shell` }),
    [agent, id],
  )

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void (async () => {
      try {
        // reopening the panel re-adopts a live shell instead of respawning
        const live = await liveSessions().catch(() => [] as string[])
        if (!live.includes(id)) {
          if (agent.machine) {
            // remote: login shell on the machine, in the session's folder
            // (${SHELL:-sh} because sshd sets SHELL; sh is the safe fallback)
            await spawnSession(id, wrapLaunch(agent.machine, 'exec "${SHELL:-sh}" -l -i', id, agent.cwd))
          } else {
            await spawnSession(id, '', agent.cwd || undefined, undefined, undefined, shell)
          }
        }
        setState('ready')
        getTerminal(id).term.focus()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        setState('failed')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (state === 'failed') {
    return (
      <div style={{ flex: 1, minHeight: 0, padding: 14, fontSize: 12, color: 'var(--red-soft)' }}>
        Could not start the shell — {err}
      </div>
    )
  }
  if (state === 'starting') {
    return <div style={{ flex: 1, minHeight: 0, padding: 14, fontSize: 12, color: 'var(--dim)' }}>Starting shell…</div>
  }
  return <TerminalPane agent={shellAgent} active={false} />
}
