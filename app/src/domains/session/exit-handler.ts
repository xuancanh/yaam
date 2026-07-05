// Session process-exit handler: subscribes to native session exits and fans the
// outcome out to session state, the board (task column + watcher note), CLI
// resume-id capture, the addon onSessionExit hook, the task watcher, the generic
// monitor, notifications, and auto-archive. The pure classification lives in
// ./exit (classifyExit); the effectful fan-out is coordinateSessionExit below,
// which takes every effect as a port so it is unit-testable without React or
// native IPC. The hook is a thin subscribe-and-delegate over the real ports.
import { useEffect } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind, TaskChatMsg } from '../../core/types'
import { dispatch } from '../../core/store'
import * as native from '../../core/native'
import { classifyExit } from './exit'
import type { SessionExit } from './exit'
import { realSessionProcessPort } from './ports'
import { removeFromGroups } from './layout-state'
import { typeForCommand } from './command'
import { updateLocatedTask } from '../board/task-state'
import type { LocatedTask } from '../board/task-state'

/** The native process-exit event we react to. */
export interface SessionExitEvent {
  id: string
  code: number | null
}

/** Everything the fan-out touches, injected so it can be faked in tests. */
export interface SessionExitPorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (fn: (s: AppState) => AppState) => void
  /** consume + return the "user stopped this session" flag */
  takeUserStopped: (id: string) => boolean
  taskForSession: (id: string) => LocatedTask | undefined
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  fireAddonHook: (hook: 'onSessionExit', event: Record<string, unknown>) => void
  runWatcher: (taskId: string, note: string) => void
  monitorEvent: (id: string, note: string) => Promise<void> | void
  /** probe a CLI session id for resume (async, best-effort) */
  detectCliSession: (probe: string, cwd: string | undefined, launchedAt: number) => Promise<string | null>
  /** delayed auto-archive (window.setTimeout in production, immediate/controllable in tests) */
  scheduleArchive: (fn: () => void, ms: number) => void
}

/** The provider's hook input: the ports minus the ones the hook wires itself
 *  (dispatch / detectCliSession / scheduleArchive come from the real runtime). */
export type SessionExitCtx = Omit<SessionExitPorts, 'dispatch' | 'detectCliSession' | 'scheduleArchive'>

/** Fan a single session exit out to every consequence. Returns the pure
 *  classification so callers/tests can assert the decision that was taken. */
export function coordinateSessionExit(e: SessionExitEvent, p: SessionExitPorts): SessionExit {
  const { stateRef, dispatch: dispatchFn, takeUserStopped, taskForSession, pushTaskChat, logEvent, notify, fireAddonHook, runWatcher, monitorEvent, detectCliSession, scheduleArchive } = p
  const agent = stateRef.current.agents.find(a => a.id === e.id)
  const userStopped = takeUserStopped(e.id)
  const taskFor = taskForSession(e.id)
  const cls = classifyExit({
    code: e.code, userStopped, ephemeral: !!agent?.ephemeral,
    autoArchive: !!agent?.autoArchive, hasTask: !!taskFor,
  })
  const { failed } = cls
  dispatchFn(s => {
    const withAgent = {
      ...s,
      agents: s.agents.map(a => a.id === e.id
      ? {
          ...a,
          status: failed ? 'error' as const : 'idle' as const,
          attention: !userStopped,
          log: a.log.concat([{ t: 'sys' as const, x: userStopped ? 'stopped by you' : `process exited${e.code !== null ? ` · code ${e.code}` : ''}` }]),
        }
      : a),
    }
    if (!taskFor) return withAgent
    return updateLocatedTask(withAgent, taskFor.task.id, t => ({
      ...t,
      col: userStopped ? t.col : failed ? 'failed' : t.col === 'done' ? 'done' : 'review',
      awaitingUser: false,
      watcherNote: userStopped
        ? 'session stopped by the user'
        : failed
          ? `one-shot exited with code ${e.code}`
          : 'one-shot finished · assessing result',
    }), taskFor.workspaceId)
  })
  if (agent && !agent.cliSessionId && agent.cmd && agent.launchedAt) {
    const probeType = typeForCommand(agent.cmd, stateRef.current.agentTypes)
    if (probeType?.probe && !/--resume|resume |--continue/.test(agent.cmd)) {
      detectCliSession(probeType.probe, agent.cwd || undefined, agent.launchedAt).then(sid => {
        if (!sid) return
        dispatchFn(s2 => ({
          ...s2,
          agents: s2.agents.map(a => a.id === e.id ? { ...a, cliSessionId: sid } : a),
        }))
      }).catch(() => {})
    }
  }
  if (agent) {
    fireAddonHook('onSessionExit', { sessionId: e.id, name: agent.name, code: e.code })
    // if this session was working a kanban task, its watcher assesses the outcome
    if (taskFor) {
      const tail = (agent.log ?? []).slice(-12).map(l => l.x).join('\n')
      pushTaskChat(taskFor.task.id, 'system', userStopped
        ? 'Session stopped by the user'
        : failed
          ? `One-shot session exited with code ${e.code}`
          : 'One-shot session exited cleanly')
      runWatcher(taskFor.task.id, userStopped
        ? `The user manually STOPPED the task's session "${agent.name}". This is a pause, not a failure — do not move the task to failed or claim completion. Update your note and wait for instructions.`
        : `The task's session "${agent.name}" exited ${failed ? `with code ${e.code} (failure)` : 'cleanly'}. Final output:\n${tail}\n\n` +
          'Assess the result against the acceptance criteria: move the task (review when it looks complete, failed if the attempt is dead), update your note, and brief the user in one short message. Ask the user only if the outcome is genuinely ambiguous.')
    }
    if (userStopped) {
      // a user stop is neither completion nor failure — the session stays
      // visible as stopped; no notifications, no auto-archive
      logEvent('edit', e.id, `${agent.name} stopped by you`)
    } else if (agent.ephemeral) {
      // one-shot agents exit by design — a clean exit is task completion
      logEvent(failed ? 'escalate' : 'done', e.id, `${agent.name} ${failed ? `one-shot run failed · exit ${e.code}` : 'completed its one-shot run'}`)
      notify(
        failed ? 'escalate' : 'done',
        `${agent.name} ${failed ? 'failed' : 'completed its task'}`,
        failed ? `exit code ${e.code} · ${agent.repo}` : `one-shot run finished · ${agent.repo}`,
        e.id,
      )
      // task sessions report through their watcher, not the generic monitor
      if (!taskFor) {
        void monitorEvent(e.id, failed
          ? `This one-shot (ephemeral) agent exited with code ${e.code} before completing. Summarize what went wrong from the output and report to Master.`
          : 'This one-shot (ephemeral) agent finished its task and exited cleanly, as designed. Summarize what it did from the final output and report a digest to Master.')
      }
      if (cls.autoArchive) {
        // give the monitor a moment to read the final screen, then tidy up
        scheduleArchive(() => dispatchFn(s => ({
          ...s,
          ...removeFromGroups(s, e.id),
          agents: s.agents.map(a => a.id === e.id ? { ...a, archived: true, attention: false } : a),
          minimizedIds: s.minimizedIds.filter(x => x !== e.id),
        })), 12000)
      }
    } else {
      logEvent(failed ? 'escalate' : 'done', e.id, `${agent.name} ${failed ? `failed · exit ${e.code}` : 'finished'}`)
      notify(
        failed ? 'escalate' : 'done',
        `${agent.name} ${failed ? 'exited with an error' : 'finished'}`,
        failed ? `exit code ${e.code} · ${agent.repo}` : `session ended · ${agent.repo}`,
        e.id,
      )
      if (!taskFor) {
        void monitorEvent(e.id,
          `The session process ${failed ? `exited with code ${e.code}` : 'finished and exited cleanly'}. Update the status and report a digest to Master.`)
      }
    }
  }
  return cls
}

export function useSessionExitHandler(ctx: SessionExitCtx): void {
  useEffect(() => {
    const offExit = native.onSessionExit(e => {
      coordinateSessionExit(e, {
        ...ctx,
        dispatch,
        detectCliSession: (probe, cwd, launchedAt) => realSessionProcessPort.detectCliSession(probe, cwd, launchedAt),
        scheduleArchive: (fn, ms) => { window.setTimeout(fn, ms) },
      })
    })
    return () => { offExit() }
  }, [ctx])
}
