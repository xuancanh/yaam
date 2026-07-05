// Session/board runtime: the interdependent cluster of attention helpers, the
// per-session monitor, per-task watcher, settle/prompt watcher, launch runtime,
// and the process-exit handler. Grouped together because they are mutually
// wired (settle → monitor, launch → watcher, exit → watcher/monitor). Sets the
// monitor/watcher/spawn cycle-refs; returns the handles the rest of the runtime
// needs. A plain factory with a start/dispose lifecycle (settle TUI scan + the
// native exit subscription); useSessionRuntime is a thin create-once adapter.
import { useEffect, useRef } from 'react'
import type { EscOption, TaskChatMsg } from '../../core/types'
import { dispatch } from '../../core/store'
import { browserClock, type StatePort } from '../../core/ports'
import { mkId } from '../../shared/id'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from '../../domains/board/task-state'
import type { LocatedTask } from '../../domains/board/task-state'
import { createSessionAttention } from '../../domains/session/attention'
import { createSessionSettle } from '../../domains/session/use-settle'
import { subscribeSessionExits } from '../../domains/session/exit-handler'
import { createLaunchRuntime } from '../../domains/session/launch-runtime'
import { createMonitorRuntime } from '../../domains/master/monitor-runtime'
import { createWatcherRuntime } from '../../domains/board/watcher-runtime'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'

export interface SessionRuntime {
  sessionScreenTail: (id: string) => string
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  appendTail: (id: string, line: string) => void
  runMonitor: (id: string, note: string) => void
  disposeMonitor: (id: string) => void
  taskForSession: (sessionId: string) => LocatedTask | undefined
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  runWatcher: (taskId: string, note: string) => Promise<void>
  disposeWatcher: (taskId: string) => void
  armResponseWatch: (id: string) => void
  bumpSettle: (id: string) => void
  clearFlagged: (id: string) => void
  disposeSettle: (id: string) => void
  clearNeeds: (id: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }) => string | null
  launchFromTemplate: (templateId: string, task?: string, workspaceId?: string, cwdOverride?: string, forceEphemeral?: boolean, contract?: string) => string | null
  spawnTaskSession: (taskId: string, opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string }) => string | null
  spawnSessionForTask: (taskId: string, workspaceId?: string) => void
  startTaskViaWatcher: (taskId: string) => void
  probeCliSession: (id: string, command: string, cwd: string, isResume: boolean) => void
  /** arm the settle TUI-scan + native exit subscription */
  start: () => void
  /** tear down the scan, timers, and exit subscription */
  dispose: () => void
}

export function createSessionRuntime(k: ConductorKernel, refs: RuntimeRefs): SessionRuntime {
  const { stateRef, later, flash, logEvent, notify } = k
  const { fireAddonHookRef, monitorEventRef, masterEventRef, runWatcherRef, spawnTaskSessionRef, userStoppedRef, taskSessionsRef } = refs

  const { sessionScreenTail, setNeedsInput, applyAgentStatus, appendTail } = createSessionAttention({
    stateRef, widOf: k.widOf, logEvent, notify,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
  })

  const monitor = createMonitorRuntime({
    stateRef, dispatch, applyAgentStatus, setNeedsInput, logEvent, notify,
    masterEvent: (n, a) => masterEventRef.current(n, a),
  })
  const runMonitor = monitor.run
  monitorEventRef.current = (id, note) => runMonitor(id, note)

  const taskForSession = (sessionId: string): LocatedTask | undefined => {
    const binding = taskSessionsRef.current.get(sessionId)
    return binding
      ? findTaskInState(stateRef.current, binding.taskId, binding.workspaceId)
      : findTaskForAgentInState(stateRef.current, sessionId)
  }

  const pushTaskChat = (taskId: string, role: TaskChatMsg['role'], text: string) => {
    dispatch(s => updateLocatedTask(s, taskId, t => ({
      ...t,
      chat: (t.chat ?? []).concat([{ id: mkId('tc'), role, text, at: Date.now() }]).slice(-80),
    })))
  }

  const watcher = createWatcherRuntime({
    stateRef, dispatch, taskSessions: taskSessionsRef, applyAgentStatus, pushTaskChat, logEvent, notify,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    spawnTaskSession: (id, extra) => spawnTaskSessionRef.current(id, extra),
  })
  const runWatcher = watcher.run
  runWatcherRef.current = (taskId, note) => { void runWatcher(taskId, note) }

  const state: StatePort = { get: () => stateRef.current, update: dispatch, subscribe: () => () => {} }
  const settle = createSessionSettle({
    state, clock: browserClock, notify, setNeedsInput, runMonitor, taskForSession,
    masterEventRef, monitorEventRef, runWatcherRef,
  })
  const { armResponseWatch, bumpSettle, clearFlagged, disposeSettle } = settle
  const clearNeeds = (id: string) => {
    clearFlagged(id)
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, attention: false, actionNeeded: undefined, ...(a.status === 'needs' ? { status: 'running' as const, escReason: undefined } : {}) }
        : a),
      messages: s.messages.map(m => (m.escFor === id && m.esc && !m.esc.resolved
        ? { ...m, esc: { ...m.esc, resolved: true, choice: 'handled in the terminal' } }
        : m)),
    }))
  }

  const exitCtx = {
    stateRef,
    takeUserStopped: (id: string) => userStoppedRef.current.delete(id),
    taskForSession, pushTaskChat, logEvent, notify,
    fireAddonHook: (hook: 'onSessionExit', event: Record<string, unknown>) => fireAddonHookRef.current(hook, event),
    runWatcher: (taskId: string, note: string) => runWatcherRef.current(taskId, note),
    monitorEvent: (id: string, note: string) => monitorEventRef.current(id, note),
  }

  const { probeCliSession, launchSession, launchFromTemplate, spawnTaskSession, spawnSessionForTask, startTaskViaWatcher } = createLaunchRuntime({
    stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch,
    pushTaskChat, runWatcher, taskSessions: taskSessionsRef,
  })
  spawnTaskSessionRef.current = (taskId, extraInstructions) => spawnTaskSession(taskId, { extraInstructions })

  let offExit: (() => void) | undefined
  return {
    sessionScreenTail, setNeedsInput, applyAgentStatus, appendTail,
    runMonitor, disposeMonitor: (id: string) => monitor.dispose(id),
    taskForSession, pushTaskChat,
    runWatcher, disposeWatcher: (tid: string) => watcher.dispose(tid),
    armResponseWatch, bumpSettle, clearFlagged, disposeSettle, clearNeeds,
    launchSession, launchFromTemplate, spawnTaskSession, spawnSessionForTask, startTaskViaWatcher, probeCliSession,
    start() { settle.start(); offExit ??= subscribeSessionExits(exitCtx) },
    dispose() { settle.dispose(); offExit?.(); offExit = undefined },
  }
}

/** React adapter: build the session runtime once; bind scan + exit subscription to the effect. */
export function useSessionRuntime(k: ConductorKernel, refs: RuntimeRefs): SessionRuntime {
  const ref = useRef<SessionRuntime>(undefined)
  if (!ref.current) ref.current = createSessionRuntime(k, refs)
  const rt = ref.current
  useEffect(() => { rt.start(); return () => rt.dispose() }, [rt])
  return rt
}
