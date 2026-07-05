// Runtime wiring: composes the four domain subsystems that own the runtime —
// session/board (attention/monitor/watcher/settle/launch/exit), the addon
// subsystem (API/agent/editor/hooks), chat+boot (integrations/chat/persistence/
// teardown), and master+scheduler — cross-wired through the declaration-cycle
// refs. createAppRuntime assembles the whole thing (kernel + subsystems + action
// composition) as a plain non-React object with an explicit start/dispose
// lifecycle; the React provider is just glue. useConductorRuntime remains for the
// existing hook composition path.
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind } from './../core/types'
import { useAppStore, dispatch } from '../core/store'
import { browserClock, createStorePort, type Disposable } from '../core/ports'
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
    launchFromTemplate: (templateId: string, task?: string) => session.launchFromTemplate(templateId, task),
    runChatMessage: chat.runChatMessage, stopChatMessage: chat.stopChatMessage,
    retryChatMessage: chat.retryChatMessage, resetChatRuntime: chat.resetChatRuntime,
    resolveChatApproval: chat.resolveChatApproval,
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

export function createAppRuntime(): AppRuntime {
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

  const activity = createActivityService(createStorePort())
  const kernel: ConductorKernel = {
    stateRef, dragId, later, flash,
    widOf: activity.widOf, logEvent: activity.logEvent, notify: activity.notify,
  }

  // ── domain subsystems, cross-wired through the cycle refs ────────────────
  const refs = createRuntimeRefs()
  const session = createSessionRuntime(kernel, refs)
  const addon = createAddonSubsystem(kernel, refs, session)
  const chat = createChatBoot(kernel, refs, session)
  const master = createMasterSubsystem(kernel, refs, session, addon)

  // one command registry + policy governs use cases across actors (addons are
  // gated by their granted capabilities; the UI/Master/watcher/chat are trusted)
  const registry = createCommandRegistry(createDefaultPolicy(id => {
    const a = stateRef.current.addons.find(x => x.id === id)
    return a?.enabled ? a.granted : []
  }))
  registerSessionCommands(registry, { stateRef })

  const actions = createConductorActions({
    ...kernel,
    ...assembleRuntimeDeps(refs, session, addon, chat, master),
    execCommand: registry.execute,
  })

  return {
    actions,
    start() {
      // refresh + (re)arm the store mirror in case state moved between build and start
      stateRef.current = useAppStore.getState()
      unsubMirror ??= useAppStore.subscribe(next => { stateRef.current = next })
      session.start(); chat.start(); master.start()
    },
    dispose() {
      session.dispose(); chat.dispose(); master.dispose()
      toastTimer?.dispose()
      for (const d of timers) d.dispose()
      timers.clear()
      unsubMirror?.(); unsubMirror = undefined
    },
  }
}
