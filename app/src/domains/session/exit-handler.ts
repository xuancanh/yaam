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
import { hasCreds } from '../../llm/client'
import { createSessionActivity, withActivityTargets } from '../activity/history'
import { captureSessionChanges } from './change-history'
import { untrustedBlock } from '../../llm/untrusted'

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
  /** put the dead session's terminal to rest: undo the modes the process left
   *  behind (alt screen, mouse, bracketed paste) and stop the cursor — a
   *  Ctrl+C'd TUI never restores them itself and the pane otherwise reads as
   *  frozen/corrupted. The real wiring defers this until the dying process's
   *  final output has drained. */
  quiesceTerminal: (id: string) => void
}

/** The provider's hook input: the ports minus the ones the hook wires itself
 *  (dispatch / detectCliSession / scheduleArchive / terminal quiesce come from
 *  the real runtime). */
export type SessionExitCtx = Omit<SessionExitPorts, 'dispatch' | 'detectCliSession' | 'scheduleArchive' | 'quiesceTerminal'>

/** Fan a single session exit out to every consequence. Returns the pure
 *  classification so callers/tests can assert the decision that was taken. */
export function coordinateSessionExit(e: SessionExitEvent, p: SessionExitPorts): SessionExit {
  const { stateRef, dispatch: dispatchFn, takeUserStopped, taskForSession, pushTaskChat, logEvent, notify, fireAddonHook, runWatcher, monitorEvent, detectCliSession, scheduleArchive } = p
  // whatever screen state the process died in, leave the pane readable
  p.quiesceTerminal(e.id)
  const agent = stateRef.current.agents.find(a => a.id === e.id)
  const userStopped = takeUserStopped(e.id)
  const taskFor = taskForSession(e.id)
  // With no Master Brain there is no watcher to assess the outcome — the board
  // must reach a final, honest state deterministically instead of parking the
  // card on "assessing result" forever.
  const settings = stateRef.current.settings
  const brainOff = !(settings?.masterEnabled && hasCreds(settings))
  const cls = classifyExit({
    code: e.code, userStopped, ephemeral: !!agent?.ephemeral,
    autoArchive: !!agent?.autoArchive, hasTask: !!taskFor,
  })
  const { failed } = cls
  // Without a monitor, retain only a lifecycle summary. Never promote a raw
  // terminal line into the synthesized Task / Now / Next status brief.
  const brainDigest = brainOff && !userStopped && !taskFor && agent
    ? {
        summary: failed ? `Session exited with code ${e.code ?? 'unknown'}` : 'Session process completed',
        nextAction: failed ? 'Inspect the failure and decide whether to retry' : 'Review the completed session',
      }
    : null
  const digestAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const outcomeEvent = agent && !userStopped
    ? createSessionActivity(stateRef.current, e.id, {
        category: 'lifecycle', actor: 'session', kind: failed ? 'fail' : 'complete',
        text: failed ? `Session exited with code ${e.code ?? 'unknown'}` : 'Session process completed',
        detail: (agent.log ?? []).slice(-3).map(l => l.x).filter(Boolean).join('\n').slice(0, 500) || undefined,
      }, taskFor?.task.id)
    : null
  dispatchFn(s => {
    const withAgent = {
      ...s,
      agents: s.agents.map(a => a.id === e.id
      ? {
          ...a,
          status: failed ? 'error' as const : 'idle' as const,
          attention: !userStopped,
          log: a.log.concat([{ t: 'sys' as const, x: userStopped ? 'stopped by you' : `process exited${e.code !== null ? ` · code ${e.code}` : ''}` }]),
          ...(brainDigest
            ? {
                summary: brainDigest.summary,
                nextAction: brainDigest.nextAction,
                summaryAt: digestAt,
                actionNeeded: failed ? `Exited with code ${e.code ?? 'unknown'} — review the failure` : undefined,
              }
            : {}),
        }
      : a),
    }
    const withTask = !taskFor ? withAgent : updateLocatedTask(withAgent, taskFor.task.id, t => ({
      ...t,
      col: userStopped ? t.col : failed ? 'failed' : t.col === 'done' ? 'done' : 'review',
      awaitingUser: false,
      watcherNote: userStopped
        ? 'session stopped by the user'
        : failed
          ? `one-shot exited with code ${e.code}`
          : brainOff
            ? 'finished · review the changes'
            : 'one-shot finished · assessing result',
    }), taskFor.workspaceId)
    return outcomeEvent ? withActivityTargets(withTask, outcomeEvent, {
      sessionId: e.id,
      taskId: taskFor?.task.id,
      workspaceId: taskFor?.workspaceId,
    }) : withTask
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
      if (brainOff) {
        // no watcher will assess this — point the user at the deterministic
        // outcome and how to get automatic assessment
        if (!userStopped) {
          pushTaskChat(taskFor.task.id, 'system', failed
            ? `Moved to Failed (exit ${e.code}). Reopen the card to retry, or inspect the session's final output above. Enable the Master Brain in Settings for automatic assessment and retries.`
            : 'Moved to Review. No Master Brain is configured to assess the result — open Review on the card to check the changes and approve. Enable the Master Brain in Settings for automatic assessment.')
        }
      } else {
        runWatcher(taskFor.task.id, userStopped
          ? `The user manually STOPPED the task's session "${agent.name}". This is a pause, not a failure — do not move the task to failed or claim completion. Update your note and wait for instructions.`
          : `The task's session "${agent.name}" exited ${failed ? `with code ${e.code} (failure)` : 'cleanly'}. Final output:\n${untrustedBlock(tail, agent.name)}\n\n` +
            'Assess the result against the acceptance criteria and move the task (review when it looks complete, failed if the attempt is dead), then update your note. ' +
            'Post ONE message to the user in the task chat that (1) summarizes concretely what was accomplished — files changed, checks run, criteria met or missed — and ' +
            '(2) when the task moved to review, explicitly asks them to review and approve the changes (the Review button on the card shows the diff). ' +
            'Ask a question only if the outcome is genuinely ambiguous.')
      }
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

/** Subscribe to native session exits and fan each out through the coordinator
 *  over the real ports. Returns an unsubscribe fn. Plain (no React). */
export function subscribeSessionExits(ctx: SessionExitCtx): () => void {
  return native.onSessionExit(e => {
    coordinateSessionExit(e, {
      ...ctx,
      dispatch,
      detectCliSession: (probe, cwd, launchedAt) => realSessionProcessPort.detectCliSession(probe, cwd, launchedAt),
      scheduleArchive: (fn, ms) => { window.setTimeout(fn, ms) },
      quiesceTerminal: id => {
        // The exit event can beat the process's final PTY bytes (separate
        // backend threads). Touching the terminal too early lets that dying
        // output — screen clears, alt-screen switches, farewell text — land on
        // the just-restored normal buffer and wreck the preserved history, so
        // wait for it to drain. Skip entirely if the session was resumed in
        // the meantime: the new process owns the terminal now.
        window.setTimeout(() => {
          const a = ctx.stateRef.current.agents.find(x => x.id === id)
          if (a?.status !== 'running' && a?.status !== 'needs') realSessionProcessPort.quiesceTerminal(id)
        }, 400)
      },
    })
    void captureSessionChanges({
      stateRef: ctx.stateRef,
      dispatch,
      taskForSession: ctx.taskForSession,
    }, e.id)
  })
}

export function useSessionExitHandler(ctx: SessionExitCtx): void {
  useEffect(() => subscribeSessionExits(ctx), [ctx])
}
