// Runtime wiring: composes the four domain subsystems that own the runtime —
// session/board (attention/monitor/watcher/settle/launch/exit), the addon
// subsystem (API/agent/editor/hooks), chat+boot (integrations/chat/persistence/
// teardown), and master+scheduler — cross-wired through the declaration-cycle
// refs. createAppRuntime assembles the whole thing (kernel + subsystems + action
// composition) as a plain non-React object with an explicit start/dispose
// lifecycle; the React provider is just glue. useConductorRuntime remains for the
// existing hook composition path.
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind, SandboxConfig, WorkspaceData, Agent } from './../core/types'
import { useAppStore, dispatch } from '../core/store'
import { browserClock, createStorePort, type Disposable } from '../core/ports'
import type { WindowRole } from '../core/window-role'
import { MASTER_GREETING } from '../core/data'
import { scopedFromState, switchWorkspaceIn } from '../domains/workspace/state'
import { emitWsSync, emitWsReattach, onWsEvent, onThisWindowClose, closeAllSatellites, destroyThisWindow, type WsSyncPayload } from '../infrastructure/native/windows'
import { createActivityService } from '../domains/activity/service'
import { createRuntimeRefs } from './runtime/refs'
import type { RuntimeRefs } from './runtime/refs'
import { createSessionRuntime } from './runtime/session'
import type { SessionRuntime } from './runtime/session'
import { createAddonSubsystem } from './runtime/addon'
import type { AddonSubsystem } from './runtime/addon'
import { createChatBoot } from './runtime/chat'
import type { ChatBoot } from './runtime/chat'
import { createMasterSubsystem } from './runtime/master'
import type { MasterSubsystem } from './runtime/master'
import { createConductorActions } from './conductor-actions'
import type { ConductorActionsDeps } from './conductor-actions'
import type { ConductorActions } from './actions'
import { createCommandRegistry } from './commands/registry'
import { createDefaultPolicy } from './commands/policy'
import { registerSessionCommands } from './commands/session-commands'
import { registerBoardCommands } from './commands/board-commands'
import { registerScheduleCommands } from './commands/schedule-commands'
import { telemetry } from '../core/telemetry'

/** Foundation the provider owns and shares with both the runtime and the actions. */
export interface ConductorKernel {
  stateRef: MutableRefObject<AppState>
  dragId: MutableRefObject<string | null>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  widOf: (s: AppState, agentId: string | null) => string
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
}

/** Everything the action composition needs beyond the kernel and the command
 *  registry entry point (both supplied directly by createAppRuntime). */
export type ConductorRuntimeDeps = Omit<ConductorActionsDeps, keyof ConductorKernel | 'execCommand'>

/** Map the four subsystems + cycle refs into the runtime deps the actions need. */
function assembleRuntimeDeps(
  refs: RuntimeRefs, session: SessionRuntime, addon: AddonSubsystem, chat: ChatBoot, master: MasterSubsystem,
): ConductorRuntimeDeps {
  return {
    connectMcp: chat.connectMcp, refreshSkillCatalog: chat.refreshSkillCatalog,
    mcpSessions: chat.mcpSessions, skillCatalogs: chat.skillCatalogs,
    fireAddonHook: (hook, event) => refs.fireAddonHookRef.current(hook, event),
    spawnSessionForTask: session.spawnSessionForTask, startTaskViaWatcher: session.startTaskViaWatcher,
    runWatcher: session.runWatcher, pushTaskChat: session.pushTaskChat,
    markUserStopped: (id: string) => refs.userStoppedRef.current.add(id),
    disposeWatcher: session.disposeWatcher, taskSessions: refs.taskSessionsRef,
    launchFromTemplate: (templateId: string, task?: string, isolate?: boolean, sandbox?: SandboxConfig | false) => session.launchFromTemplate(templateId, task, undefined, undefined, undefined, undefined, isolate, undefined, sandbox),
    runChatMessage: chat.runChatMessage, stopChatMessage: chat.stopChatMessage,
    retryChatMessage: chat.retryChatMessage, resetChatRuntime: chat.resetChatRuntime,
    replayChatMessage: chat.replayChatMessage,
    resolveChatApproval: chat.resolveChatApproval,
    compactChatContext: chat.compactChatContext,
    installPackage: addon.installPackage, sendAddonChat: addon.sendAddonChat,
    makeAddonApi: addon.makeAddonApi, disposeAddon: addon.disposeAddon,
    runMaster: master.runMaster, disposeSessionRuntime: chat.disposeSessionRuntime, abortMaster: master.abortMaster,
    toolApprovals: refs.toolApprovalsRef,
    armResponseWatch: session.armResponseWatch, clearFlagged: session.clearFlagged,
    launchSession: session.launchSession, probeCliSession: session.probeCliSession,
    appendTail: session.appendTail, clearNeeds: session.clearNeeds, bumpSettle: session.bumpSettle,
  }
}

/** The non-React application runtime: owns state mirroring, timers, every domain
 *  subsystem, and the composed action surface. Constructed once; the provider
 *  calls start()/dispose() and hands `actions` to the UI. */
export interface AppRuntime {
  actions: ConductorActions
  start: () => void
  dispose: () => void
}

export function createAppRuntime(role: WindowRole = { kind: 'main' }): AppRuntime {
  // ── foundation kernel (no React) ─────────────────────────────────────────
  const stateRef: MutableRefObject<AppState> = { current: useAppStore.getState() }
  // The store→stateRef mirror is (un)subscribed in start/dispose, not here, so a
  // dispose→start cycle (React StrictMode dev remount) re-arms it rather than
  // leaving stateRef frozen.
  let unsubMirror: (() => void) | undefined
  const dragId: MutableRefObject<string | null> = { current: null }

  // tracked timers so teardown can cancel outstanding work
  const timers = new Set<Disposable>()
  const later = (ms: number, fn: () => void) => {
    const d: Disposable = browserClock.setTimeout(() => { timers.delete(d); fn() }, ms)
    timers.add(d)
  }
  let toastTimer: Disposable | undefined
  const flash = (t: string) => {
    dispatch(s => ({ ...s, toast: t }))
    toastTimer?.dispose()
    toastTimer = browserClock.setTimeout(() => dispatch(s => ({ ...s, toast: null })), 2600)
  }

  const statePort = createStorePort()
  const activity = createActivityService(statePort)
  const kernel: ConductorKernel = {
    stateRef, dragId, later, flash,
    widOf: activity.widOf, logEvent: activity.logEvent, notify: activity.notify,
  }

  // ── domain subsystems, cross-wired through the cycle refs ────────────────
  const refs = createRuntimeRefs()

  // one command registry + policy governs use cases across actors (addons are
  // gated by their granted capabilities; the UI/Master/watcher/chat are trusted).
  // Audit flows into telemetry — denials surface as warnings, not silent drops.
  const registry = createCommandRegistry(createDefaultPolicy(id => {
    const a = stateRef.current.addons.find(x => x.id === id)
    return a?.enabled ? a.granted : []
  }), {
    onAudit: e => telemetry.emit({
      severity: e.decision === 'deny' ? 'warn' : 'debug',
      domain: 'commands', message: `${e.command} · ${e.decision}`, actor: e.actor.kind,
      detail: e.error ? { error: e.error } : undefined,
    }),
  })
  registerSessionCommands(registry, { stateRef, markUserStopped: id => refs.userStoppedRef.current.add(id) })
  registerBoardCommands(registry, statePort, (hook, event) => refs.fireAddonHookRef.current(hook, event))
  registerScheduleCommands(registry, statePort)
  const addonExec = (name: string, input: unknown, addonId: string) =>
    void registry.execute(name, input, { actor: { kind: 'addon', addonId } }).catch(() => {})
  const masterSendLine = (sid: string, text: string) =>
    void registry.execute('send_to_session', { sessionId: sid, text }, { actor: { kind: 'master' } }).catch(() => {})
  const masterStopLine = (sid: string) =>
    void registry.execute('stop_session', { sessionId: sid }, { actor: { kind: 'master' } }).catch(() => {})

  const session = createSessionRuntime(kernel, refs)
  const addon = createAddonSubsystem(kernel, refs, session, addonExec)
  const chat = createChatBoot(kernel, refs, session, role)
  const master = createMasterSubsystem(kernel, refs, session, addon, chat.runChatMessage, masterSendLine, masterStopLine)

  const actions = createConductorActions({
    ...kernel,
    ...assembleRuntimeDeps(refs, session, addon, chat, master),
    execCommand: registry.execute,
  })
  // close the cycle: addons (built earlier) reach the board review verbs here
  refs.taskReviewRef.current = { approve: actions.approveTaskReview, reject: actions.rejectTaskReview }

  // teardown for the multi-window wiring (satellite sync / main listeners)
  const windowDisposers: Array<() => void> = []
  let syncTimer: Disposable | undefined

  return {
    actions,
    start() {
      // refresh + (re)arm the store mirror in case state moved between build and start
      stateRef.current = useAppStore.getState()
      unsubMirror ??= useAppStore.subscribe(next => { stateRef.current = next })
      session.start(); chat.start()

      if (role.kind === 'main') {
        master.start(); addon.start()
        // main is the sole persistence writer: absorb each satellite's workspace
        // slice into the background copy so its edits round-trip to disk.
        windowDisposers.push(onWsEvent<WsSyncPayload>('ws:sync', p =>
          actions.mergeDetachedWorkspace(p.workspaceId, p.data as WorkspaceData, p.agents as Agent[])))
        windowDisposers.push(onWsEvent<WsSyncPayload>('ws:reattach', p =>
          actions.reattachWorkspace(p.workspaceId, p.data as WorkspaceData, p.agents as Agent[])))
        // closing the main window quits the app: flush (bounded), then close the
        // workspace satellites and destroy main so no orphan window survives.
        windowDisposers.push(onThisWindowClose(async () => {
          await Promise.race([chat.flush(), new Promise<void>(r => browserClock.setTimeout(() => r(), 3000))])
          await closeAllSatellites()
          await destroyThisWindow()
        }))
      } else {
        // satellite: pin to its workspace once hydration is ready, then keep main
        // in sync with a debounced forward of the workspace slice + its sessions.
        const wsId = role.workspaceId
        const slice = (): WsSyncPayload => ({
          workspaceId: wsId,
          data: scopedFromState(stateRef.current),
          agents: stateRef.current.agents.filter(a => a.workspaceId === wsId),
        })
        let pinned = false
        const armSync = () => {
          syncTimer?.dispose()
          syncTimer = browserClock.setTimeout(() => { void emitWsSync(slice()) }, 1500)
        }
        windowDisposers.push(useAppStore.subscribe(() => {
          const st = stateRef.current
          if (!pinned && st.bootStatus === 'ready') {
            pinned = true
            if (st.activeWorkspace !== wsId) dispatch(s => switchWorkspaceIn(s, wsId, MASTER_GREETING))
          }
          if (pinned && st.activeWorkspace === wsId) armSync()
        }))
        // closing only this satellite: hand its final slice back to main, then
        // destroy just this window (the app and main keep running).
        windowDisposers.push(onThisWindowClose(async () => {
          syncTimer?.dispose()
          await emitWsReattach(slice())
          await destroyThisWindow()
        }))
      }
    },
    dispose() {
      session.dispose(); chat.dispose()
      if (role.kind === 'main') { master.dispose(); addon.dispose() }
      syncTimer?.dispose()
      for (const d of windowDisposers) d()
      windowDisposers.length = 0
      toastTimer?.dispose()
      for (const d of timers) d.dispose()
      timers.clear()
      unsubMirror?.(); unsubMirror = undefined
    },
  }
}
