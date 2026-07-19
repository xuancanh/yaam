// Session lifecycle actions: archive/unarchive, delete, resume (respawn the
// CLI's own resume flow), launch a raw command session, send a line to a PTY, and
// stop. These drive the native process + xterm lifecycle, so they take the
// provider's runtime callbacks (launch/probe/dispose/terminal-activity) via ctx.
// Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType, SandboxConfig } from '../../core/types'
import { dispatch } from '../../core/store'
import { focusSessionIn, removeFromGroups } from './layout-state'
import { envPrefix, typeForCommand } from './command'
import { killRemote, tmuxName, wrapLaunch } from './remote-machine'
import { sandboxLocalWrap, sandboxRemoteWrap } from './sandbox'
import { probeRemoteCliSession } from './remote-probe'
import { execCommand, worktreeMerge, worktreeRemove } from '../../core/native'
import { realSessionProcessPort } from './ports'
import type { SessionProcessPort } from './ports'
import { inferLegacyTerminalShell } from '../../store/state-helpers'
import { createSessionActivity, withActivityTargets } from '../activity/history'
import { findTaskForAgentInState } from '../board/task-state'

export interface SessionActionsCtx {
  stateRef: MutableRefObject<AppState>
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  markUserStopped: (id: string) => void
  disposeSessionRuntime: (id: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string; isolate?: boolean; detached?: boolean; machineId?: string; sandbox?: SandboxConfig }) => string | null
  probeCliSession: (id: string, command: string, cwd: string, isResume: boolean) => void
  armResponseWatch: (id: string) => void
  appendTail: (id: string, line: string) => void
  clearNeeds: (id: string) => void
  bumpSettle: (id: string) => void
  bufferOutput?: (id: string, line: string) => void
  recordTerminalSubmit?: (id: string, text: string) => void
  /** native PTY + terminal capability; defaults to the real IPC-backed port */
  port?: SessionProcessPort
  /** application command registry entry point (routes the PTY write + policy) */
  execCommand?: <R = unknown>(name: string, input: unknown, ctx: { actor: { kind: 'user' } }) => Promise<R>
}

export interface SessionActions {
  /** merge a worktree-isolated session's changes back into the original
   *  checkout and drop the mirror. '' on success, else a failure summary.
   *  `message` overrides the default `yaam: <session name>` commit message. */
  mergeSessionWorktree: (id: string, message?: string) => Promise<string>
  /** drop a session's worktree WITHOUT merging — the changes are discarded and
   *  the session returns to the original checkout. '' on success. */
  discardSessionWorktree: (id: string) => Promise<string>
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  resume: (id: string) => void
  /** user-initiated full terminal reset (modes + scrollback) — the manual fix
   *  for a corrupted pane; never triggered automatically */
  refreshTerminal: (id: string) => void
  newRealSession: (command: string, cwd: string, terminalShell?: string, isolate?: boolean, detached?: boolean, machineId?: string, sandbox?: SandboxConfig) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}

export function useSessionActions(ctx: SessionActionsCtx): SessionActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSessionActions(ctx), [ctx.stateRef, ctx.flash, ctx.logEvent, ctx.markUserStopped, ctx.disposeSessionRuntime, ctx.launchSession, ctx.probeCliSession, ctx.armResponseWatch, ctx.appendTail, ctx.clearNeeds, ctx.bumpSettle, ctx.bufferOutput, ctx.recordTerminalSubmit, ctx.port, ctx.execCommand])
}

/** The session lifecycle actions as a plain factory (no React), so they can be
 *  unit-tested with a fake SessionProcessPort and the real store. */
export function createSessionActions(ctx: SessionActionsCtx): SessionActions {
  const { stateRef, flash, logEvent, markUserStopped, disposeSessionRuntime, launchSession, probeCliSession, armResponseWatch, appendTail, clearNeeds, bumpSettle } = ctx
  const port = ctx.port ?? realSessionProcessPort
  const recordTerminalSubmit = ctx.recordTerminalSubmit ?? ((id: string, text: string) => {
    const st = stateRef.current
    const task = findTaskForAgentInState(st, id)
    const event = createSessionActivity(st, id, {
      category: 'action', actor: 'user', kind: 'send', text: text.trim() ? 'Submitted terminal input' : 'Pressed Enter in terminal',
      detail: text.trim().slice(0, 1000) || undefined,
    }, task?.task.id)
    dispatch(s => withActivityTargets(s, event, {
      sessionId: id, taskId: task?.task.id, workspaceId: task?.workspaceId,
    }))
    armResponseWatch(id)
  })
  return {
    mergeSessionWorktree: async (id, message) => {
      const agent = ctx.stateRef.current.agents.find(a => a.id === id)
      if (!agent?.worktree) return 'this session has no worktree'
      if (agent.status === 'running' || agent.status === 'needs') return 'stop the session before merging its worktree'
      const results = await worktreeMerge(agent.worktree.root, message?.trim() || `yaam: ${agent.name.slice(0, 60)}`).catch(e => [
        { name: 'worktree', status: 'error', detail: e instanceof Error ? e.message : String(e) },
      ])
      const summary = results.map(r => `${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')
      if (results.some(r => r.status === 'error')) return summary
      try {
        await worktreeRemove(agent.worktree.root)
      } catch (e) {
        return `changes merged, but worktree cleanup failed: ${e instanceof Error ? e.message : String(e)}`
      }
      const event = createSessionActivity(stateRef.current, id, {
        category: 'decision', actor: 'user', kind: 'approve', text: 'Merged session worktree', detail: summary,
      })
      dispatch(s => withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, cwd: agent.worktree!.base, worktree: undefined, log: a.log.concat([{ t: 'sys' as const, x: `worktree merged back:\n${summary}` }]) }
          : a),
      }, event, { sessionId: id, taskId: event.taskId }))
      ctx.logEvent('done', id, `Merged worktree changes from “${agent.name}”`)
      ctx.flash('Worktree merged back')
      return ''
    },

    discardSessionWorktree: async id => {
      const agent = ctx.stateRef.current.agents.find(a => a.id === id)
      if (!agent?.worktree) return 'this session has no worktree'
      if (agent.status === 'running' || agent.status === 'needs') return 'stop the session before discarding its worktree'
      try {
        await worktreeRemove(agent.worktree.root)
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
      const event = createSessionActivity(stateRef.current, id, {
        category: 'decision', actor: 'user', kind: 'deny', text: 'Discarded session worktree',
      })
      dispatch(s => withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, cwd: agent.worktree!.base, worktree: undefined, log: a.log.concat([{ t: 'sys' as const, x: 'worktree discarded — changes were not merged' }]) }
          : a),
      }, event, { sessionId: id, taskId: event.taskId }))
      ctx.logEvent('edit', id, `Discarded worktree of “${agent.name}”`)
      ctx.flash('Worktree discarded')
      return ''
    },

    archiveSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.status === 'running' || agent?.status === 'needs') {
        markUserStopped(id)
        port.killSession(id).catch(() => {})
      }
      // free the xterm buffer + runtime registries; the agent (with its log
      // tail) stays persisted and the terminal is rebuilt on unarchive
      disposeSessionRuntime(id)
      const event = createSessionActivity(stateRef.current, id, { category: 'action', actor: 'user', kind: 'archive', text: 'Archived session' })
      dispatch(s => withActivityTargets({
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.map(a => a.id === id ? { ...a, archived: true, status: 'idle' as const, escReason: undefined } : a),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
      }, event, { sessionId: id, taskId: event.taskId }))
      flash(`Archived ${agent?.name ?? 'session'}`)
      logEvent('edit', id, `Archived session ${agent?.name ?? id}`)
    },

    unarchiveSession: id => {
      // the xterm was disposed on archive — recreate it and replay the retained
      // (dimmed) tail, mirroring how restore rebuilds a paused session
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent && agent.kind !== 'chat') {
        port.disposeTerminal(id)
        const term = port.attachTerminal(id, line => { appendTail(id, line); ctx.bufferOutput?.(id, line) }, () => clearNeeds(id), () => bumpSettle(id), text => recordTerminalSubmit(id, text))
        for (const l of agent.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
        term.writeln('\x1b[33m── unarchived · press ▶ to relaunch ──\x1b[0m')
      }
      const event = createSessionActivity(stateRef.current, id, { category: 'action', actor: 'user', kind: 'restore', text: 'Restored session' })
      dispatch(s => focusSessionIn(withActivityTargets(s, event, { sessionId: id, taskId: event.taskId }), id))
    },

    deleteSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      markUserStopped(id)
      port.killSession(id).catch(() => {})
      disposeSessionRuntime(id)
      port.removeSession(id).catch(() => {}) // drop its persisted file too
      const task = findTaskForAgentInState(stateRef.current, id)
      const event = createSessionActivity(stateRef.current, id, {
        category: 'action', actor: 'user', kind: 'delete', text: `Deleted session · ${agent?.name ?? id}`,
      }, task?.task.id)
      dispatch(s => {
        const without = {
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.filter(a => a.id !== id),
        tasks: s.tasks.map(t => (t.agentId === id || t.agentIds?.includes(id)
          ? { ...t, agentId: t.agentId === id ? null : t.agentId, agentIds: (t.agentIds ?? []).filter(x => x !== id) }
          : t)),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
        panel: s.panel?.agentId === id ? null : s.panel,
        }
        return task ? withActivityTargets(without, event, { taskId: task.task.id, workspaceId: task.workspaceId }) : without
      })
      flash(`Deleted ${agent?.name ?? 'session'}`)
      logEvent('edit', null, `Deleted session ${agent?.name ?? id}`)
    },

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.kind === 'chat') return // chat agents have no process; just send a message
      const terminalShell = agent?.terminalShell ?? inferLegacyTerminalShell(agent?.cmd)
      let resumeNote = 'session resumed'
      if (agent?.kind === 'real' && agent.cmd && agent.status !== 'running') {
        // Detached sessions own the real CLI in their host process, so the
        // agent type's normal resume command never applies: resume goes
        // through detachedSpawn, which reattaches a live host or relaunches
        // the stored command when the host ended.
        let cmd = agent.cmd
        const type = stateRef.current.agentTypes.find(t => t.id === agent.typeId)
          ?? typeForCommand(agent.cmd, stateRef.current.agentTypes)
        const machine = agent.machine
        if (machine) {
          // Remote resume rebuilds the ssh wrap. We minted the CLI session id at
          // launch (claude --session-id), so restart with the resume command
          // (claude --resume <id>) — the conversation carries over on the host
          // instead of starting fresh. Detached also reattaches its tmux session
          // (new-session -A ignores the command while it's alive, and resumes the
          // id if it had ended); plain just re-runs the resume command over ssh.
          if (type?.resumeCmd?.includes('{id}') && agent.cliSessionId) {
            cmd = type.resumeCmd.replace('{id}', agent.cliSessionId)
            resumeNote = agent.detached
              ? `reattaching to ${machine.label} · tmux ${tmuxName(id)}`
              : `resuming ${type.name} session ${agent.cliSessionId} on ${machine.label}`
          } else if (type?.resumeCmd && !type.resumeCmd.includes('{id}')) {
            cmd = type.resumeCmd
            resumeNote = agent.detached
              ? `reattaching to ${machine.label} · tmux ${tmuxName(id)}`
              : `restarting on ${machine.label} · ${cmd}`
          } else {
            resumeNote = agent.detached
              ? `reattaching to ${machine.label} · tmux ${tmuxName(id)}`
              : `restarting on ${machine.label}`
          }
        } else if (agent.detached) {
          resumeNote = 'reattaching detached session — relaunches it if it had ended'
        } else if (type?.resumeCmd) {
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
        // the respawn reuses this xterm. NEVER wipe the scrollback
        // automatically — re-normalize the modes (alt screen, mouse tracking,
        // …) and let the respawned CLI repaint its own content. If the old
        // TUI died mid-render, warn: the pane header's Clear-terminal button
        // is the explicit fix for a garbled screen.
        const wasCorrupted = port.isAltScreen(id)
        port.restoreTerminalModes(id)
        if (wasCorrupted) resumeNote += ' · the previous TUI was killed mid-render — if the screen looks garbled, use the pane\'s ↻ Clear terminal button'
        // spawn at the pane's REAL size — the pane is already mounted on
        // resume, so nothing would ever correct the backend's 24×80 default
        // and the CLI would keep rendering for the wrong terminal
        const size = port.terminalSize(id)
        const failResume = (err: unknown) => {
          dispatch(s => ({
            ...s,
            agents: s.agents.map(a => a.id === id
              ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err' as const, x: String(err) }]) }
              : a),
          }))
        }
        if (machine) {
          // rebuild the same ssh wrap around the resume command resolved above
          // (resume-by-id for claude, else the plain command); a sandboxed
          // session re-enters its bwrap sandbox on the host
          Promise.resolve().then(() => {
            const base = `${envPrefix(type?.env)}${cmd}`.trim()
            const inner = agent.sandbox ? sandboxRemoteWrap(base, agent.cwd || machine.remoteDir, agent.sandbox) : base
            const commandShell = stateRef.current.settings?.shell || 'zsh'
            return port.spawnSession(id, wrapLaunch(machine, inner, id, agent.cwd, agent.detached), undefined, size?.rows, size?.cols, undefined, commandShell)
          }).then(() => { setTimeout(() => port.repaintTerminal(id), 400) })
            .catch(failResume)
          // best-effort: (re)capture codex's session id from the host so a future
          // resume can `codex resume <id>`. Recovers the id if it wasn't caught at
          // launch (e.g. app closed early) or after a clean restart; no-op for
          // claude (id already known) and harmless when the id is unchanged.
          probeRemoteCliSession(id, machine, type?.probe, true)
        } else if (agent.detached) {
          // Ensure the host first: a live one is simply reattached; a dead one
          // is relaunched from the stored command. Legacy agents persisted the
          // attach wrapper as their cmd — pass '' so the host's on-disk spec
          // (which kept the real command) is reused instead.
          const hostBase = cmd.includes('--yaam-attach') ? '' : `${envPrefix(type?.env)}${cmd}`.trim()
          const hostShell = terminalShell ? undefined : (stateRef.current.settings?.shell || 'zsh')
          const spawnHost = (hostCmd: string) => port.detachedSpawn(id, hostCmd, agent.cwd || undefined, hostShell, size?.rows, size?.cols)
            .then(attachCmd => port.spawnSession(id, attachCmd, agent.cwd || undefined, size?.rows, size?.cols, undefined, undefined))
            .then(() => { setTimeout(() => port.repaintTerminal(id), 400) })
            .catch(failResume)
          // a sandboxed relaunch rebuilds its wrapper first (fail closed); ''
          // reuses the host's on-disk spec, which kept the wrap from launch
          if (agent.sandbox && hostBase) {
            port.sandboxWrapper(id, agent.cwd || '', agent.sandbox.extraPaths ?? [], !!agent.sandbox.denyNetwork)
              .then(w => spawnHost(sandboxLocalWrap(w, hostBase)))
              .catch(failResume)
          } else void spawnHost(hostBase)
        } else {
          const base = `${envPrefix(type?.env)}${cmd}`.trim()
          const commandShell = terminalShell ? undefined : (stateRef.current.settings?.shell || 'zsh')
          const spawnLocal = (spawnCommand: string) => port.spawnSession(id, spawnCommand, agent.cwd || undefined, size?.rows, size?.cols, terminalShell, commandShell)
            .then(() => {
              // …and nudge a repaint once the CLI has booted, so resumed TUIs
              // draw a correct first frame even if layout shifted meanwhile
              setTimeout(() => port.repaintTerminal(id), 400)
            })
            .catch(failResume)
          // fail closed: a sandboxed session that can't rebuild its wrapper
          // errors instead of resuming unsandboxed
          if (agent.sandbox && !terminalShell) {
            port.sandboxWrapper(id, agent.cwd || '', agent.sandbox.extraPaths ?? [], !!agent.sandbox.denyNetwork)
              .then(w => spawnLocal(sandboxLocalWrap(w, base)))
              .catch(failResume)
          } else void spawnLocal(base)
          probeCliSession(id, cmd, agent.cwd || '', true)
        }
      }
      const event = createSessionActivity(stateRef.current, id, {
        category: 'action', actor: 'user', kind: 'launch', text: 'Resumed session', detail: resumeNote,
      })
      dispatch(s => focusSessionIn(withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, terminalShell, status: 'running' as const, log: a.log.concat([{ t: 'sys', x: resumeNote }]) }
          : a),
      }, event, { sessionId: id, taskId: event.taskId }), id))
    },

    refreshTerminal: id => {
      // restore sane modes first so the reset lands on the normal buffer,
      // then wipe; a live process repaints on the follow-up resize/redraw
      port.restoreTerminalModes(id)
      port.resetTerminal(id)
      flash('Terminal cleared')
    },

    newRealSession: (command, cwd, terminalShell, isolate, detached, machineId, sandbox) => {
      const id = launchSession(command, cwd, undefined, undefined, undefined, { terminalShell, isolate, detached, machineId, sandbox })
      if (id) {
        const label = command.trim().slice(0, 80)
        logEvent('route', id, `Launched session · ${label}`)
        const event = createSessionActivity(stateRef.current, id, {
          category: 'lifecycle', actor: 'user', kind: 'launch', text: 'Launched session',
        })
        dispatch(s => withActivityTargets(s, event, { sessionId: id }))
        flash('Session launched')
      }
    },

    sendInput: (id, text) => {
      armResponseWatch(id)
      const event = createSessionActivity(stateRef.current, id, {
        category: 'action', actor: 'user', kind: 'send', text: 'Sent terminal input', detail: text.trim().slice(0, 240) || undefined,
      })
      dispatch(s => withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, log: a.log.concat([{ t: 'you', x: text }]) }
          : a),
      }, event, { sessionId: id, taskId: event.taskId }))
      // route the PTY write through the command registry (user actor) so every
      // caller shares one send path + policy; fall back to the port directly
      // when no registry is wired (unit tests, standalone use)
      if (ctx.execCommand) void ctx.execCommand('send_to_session', { sessionId: id, text }, { actor: { kind: 'user' } })
      else port.sendLine(id, text)
    },

    stopSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      // a LOCAL detached session's PTY lives in a host process — end it for real,
      // not just drop the attach client
      if (agent?.detached && !agent.machine) void port.detachedKill(id)
      // a DETACHED machine session's agent lives in a remote tmux session —
      // killing the local ssh PTY alone would just detach it, so end it over ssh
      // (a plain machine session dies with the ssh PTY via SIGHUP). If we can't
      // reach the host, say so instead of silently claiming it stopped.
      const machine = agent?.detached ? agent.machine : undefined
      if (machine) {
        const warn = (msg: string) => dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === id ? { ...a, log: a.log.concat([{ t: 'warn' as const, x: msg }]) } : a),
        }))
        void execCommand(killRemote(machine, id))
          .then(r => { if (r.code !== 0) warn(`⚠ couldn't stop the remote tmux session on ${machine.host} (${r.output.trim().slice(0, 120) || `exit ${r.code}`}) — it may still be running; check with: tmux kill-session -t ${tmuxName(id)}`) })
          .catch(e => warn(`⚠ couldn't reach ${machine.host} to stop the remote tmux session (${e instanceof Error ? e.message : String(e)}) — it may still be running`))
      }
      // stop-flag + kill go through the shared command (user actor); the UI
      // status/log/toast stay here. Fall back to the port when unwired.
      if (ctx.execCommand) void ctx.execCommand('stop_session', { sessionId: id }, { actor: { kind: 'user' } })
      else { markUserStopped(id); port.killSession(id).catch(() => {}) }
      const event = createSessionActivity(stateRef.current, id, { category: 'action', actor: 'user', kind: 'stop', text: 'Stopped session' })
      dispatch(s => withActivityTargets({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'idle' as const, log: a.log.concat([{ t: 'sys', x: 'stopped by you' }]) }
          : a),
      }, event, { sessionId: id, taskId: event.taskId }))
      flash('Session stopped')
    },
  }
}
