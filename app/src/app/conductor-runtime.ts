// Runtime wiring: composes the four domain sub-hooks that own the runtime —
// session/board (attention/monitor/watcher/settle/launch/exit), the addon
// subsystem (API/agent/editor/hooks), chat+boot (integrations/chat/persistence/
// teardown), and master+scheduler — cross-wired through the declaration-cycle
// refs. Takes the provider's foundation kernel and returns exactly the deps the
// action composition needs. Kept thin so ConductorProvider is a composition root.
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind } from './../core/types'
import { useRuntimeRefs } from './runtime/refs'
import { useSessionRuntime } from './runtime/session'
import { useAddonSubsystem } from './runtime/addon'
import { useChatBoot } from './runtime/chat'
import { useMasterSubsystem } from './runtime/master'
import type { ConductorActionsDeps } from './conductor-actions'

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

/** Everything the action composition needs beyond the kernel. */
export type ConductorRuntimeDeps = Omit<ConductorActionsDeps, keyof ConductorKernel>

export function useConductorRuntime(k: ConductorKernel): ConductorRuntimeDeps {
  const refs = useRuntimeRefs()
  const session = useSessionRuntime(k, refs)
  const addon = useAddonSubsystem(k, refs, session)
  const chat = useChatBoot(k, refs, session)
  const master = useMasterSubsystem(k, refs, session, addon)

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
    installPackage: addon.installPackage, sendAddonChat: addon.sendAddonChat,
    makeAddonApi: addon.makeAddonApi, disposeAddon: addon.disposeAddon,
    runMaster: master.runMaster, disposeSessionRuntime: chat.disposeSessionRuntime, abortMaster: master.abortMaster,
    toolApprovals: refs.toolApprovalsRef,
    armResponseWatch: session.armResponseWatch, clearFlagged: session.clearFlagged,
    launchSession: session.launchSession, probeCliSession: session.probeCliSession,
    appendTail: session.appendTail, clearNeeds: session.clearNeeds, bumpSettle: session.bumpSettle,
  }
}
