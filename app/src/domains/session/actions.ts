// Session lifecycle actions: archive/unarchive, delete, resume (respawn the
// CLI's own resume flow), launch a raw command session, send a line to a PTY, and
// stop. These drive the native process + xterm lifecycle, so they take the
// provider's runtime callbacks (launch/probe/dispose/terminal-activity) via ctx.
// Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType } from '../../core/types'
import { dispatch } from '../../core/store'
import { focusSessionIn, removeFromGroups } from './layout-state'
import { envPrefix, typeForCommand } from './command'
import { realSessionProcessPort } from './ports'
import type { SessionProcessPort } from './ports'
import { inferLegacyTerminalShell } from '../../store/state-helpers'

export interface SessionActionsCtx {
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  markUserStopped: (id: string) => void
  disposeSessionRuntime: (id: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }) => string | null
  probeCliSession: (id: string, command: string, cwd: string, isResume: boolean) => void
  armResponseWatch: (id: string) => void
  appendTail: (id: string, line: string) => void
  clearNeeds: (id: string) => void
  bumpSettle: (id: string) => void
  /** native PTY + terminal capability; defaults to the real IPC-backed port */
  port?: SessionProcessPort
}

export interface SessionActions {
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  resume: (id: string) => void
  newRealSession: (command: string, cwd: string, terminalShell?: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}

export function useSessionActions(ctx: SessionActionsCtx): SessionActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSessionActions(ctx), [ctx.stateRef, ctx.flash, ctx.logEvent, ctx.markUserStopped, ctx.disposeSessionRuntime, ctx.launchSession, ctx.probeCliSession, ctx.armResponseWatch, ctx.appendTail, ctx.clearNeeds, ctx.bumpSettle, ctx.port])
}

/** The session lifecycle actions as a plain factory (no React), so they can be
 *  unit-tested with a fake SessionProcessPort and the real store. */
export function createSessionActions(ctx: SessionActionsCtx): SessionActions {
  const { stateRef, flash, logEvent, markUserStopped, disposeSessionRuntime, launchSession, probeCliSession, armResponseWatch, appendTail, clearNeeds, bumpSettle } = ctx
  const port = ctx.port ?? realSessionProcessPort
  return {
    archiveSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.status === 'running' || agent?.status === 'needs') {
        markUserStopped(id)
        port.killSession(id).catch(() => {})
      }
      // free the xterm buffer + runtime registries; the agent (with its log
      // tail) stays persisted and the terminal is rebuilt on unarchive
      disposeSessionRuntime(id)
      dispatch(s => ({
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.map(a => a.id === id ? { ...a, archived: true, status: 'idle' as const, escReason: undefined } : a),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
      }))
      flash(`Archived ${agent?.name ?? 'session'}`)
      logEvent('edit', id, `Archived session ${agent?.name ?? id}`)
    },

    unarchiveSession: id => {
      // the xterm was disposed on archive — recreate it and replay the retained
      // (dimmed) tail, mirroring how restore rebuilds a paused session
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent && agent.kind !== 'chat') {
        port.disposeTerminal(id)
        const term = port.attachTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id), () => armResponseWatch(id))
        for (const l of agent.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
        term.writeln('\x1b[33m── unarchived · press ▶ to relaunch ──\x1b[0m')
      }
      dispatch(s => focusSessionIn(s, id))
    },

    deleteSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      markUserStopped(id)
      port.killSession(id).catch(() => {})
      disposeSessionRuntime(id)
      port.removeSession(id).catch(() => {}) // drop its persisted file too
      dispatch(s => ({
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.filter(a => a.id !== id),
        tasks: s.tasks.map(t => (t.agentId === id || t.agentIds?.includes(id)
          ? { ...t, agentId: t.agentId === id ? null : t.agentId, agentIds: (t.agentIds ?? []).filter(x => x !== id) }
          : t)),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
        panel: s.panel?.agentId === id ? null : s.panel,
      }))
      flash(`Deleted ${agent?.name ?? 'session'}`)
      logEvent('edit', null, `Deleted session ${agent?.name ?? id}`)
    },

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.kind === 'chat') return // chat agents have no process; just send a message
      const terminalShell = agent?.terminalShell ?? inferLegacyTerminalShell(agent?.cmd)
      let resumeNote = 'session resumed'
      if (agent?.kind === 'real' && agent.cmd && agent.status !== 'running') {
        // prefer the CLI's own resume flow so the conversation continues
        let cmd = agent.cmd
        const type = stateRef.current.agentTypes.find(t => t.id === agent.typeId)
          ?? typeForCommand(agent.cmd, stateRef.current.agentTypes)
        if (type?.resumeCmd) {
          if (type.resumeCmd.includes('{id}')) {
            if (agent.cliSessionId) {
              cmd = type.resumeCmd.replace('{id}', agent.cliSessionId)
              resumeNote = `resuming ${type.name} session ${agent.cliSessionId}`
            } else if (type.resumeFallbackCmd) {
              cmd = type.resumeFallbackCmd
              resumeNote = `no captured session id — resuming most recent via · ${cmd}`
            }
          } else {
            cmd = type.resumeCmd
            resumeNote = `resuming via · ${cmd}`
          }
        }
        port.spawnSession(id, `${envPrefix(type?.env)}${cmd}`.trim(), agent.cwd || undefined, undefined, undefined, terminalShell).catch(() => {})
        probeCliSession(id, cmd, agent.cwd || '', true)
      }
      dispatch(s => focusSessionIn({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, terminalShell, status: 'running' as const, log: a.log.concat([{ t: 'sys', x: resumeNote }]) }
          : a),
      }, id))
    },

    newRealSession: (command, cwd, terminalShell) => {
      const id = launchSession(command, cwd, undefined, undefined, undefined, { terminalShell })
      if (id) {
        logEvent('route', id, `Launched session · ${command.trim()}`)
        flash('Session launched')
      }
    },

    sendInput: (id, text) => {
      armResponseWatch(id)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, log: a.log.concat([{ t: 'you', x: text }]) }
          : a),
      }))
      port.sendLine(id, text)
    },

    stopSession: id => {
      markUserStopped(id)
      port.killSession(id).catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'idle' as const, log: a.log.concat([{ t: 'sys', x: 'stopped by you' }]) }
          : a),
      }))
      flash('Session stopped')
    },
  }
}
