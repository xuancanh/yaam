// Action composition: instantiate every domain action slice (memoizing each ctx
// on its stable callback/ref deps so the slices — and therefore ActionsCtx — stay
// referentially stable across state-driven re-renders) and merge them into the
// single ConductorActions surface. Pulled out of the provider so the composition
// root just wires runtimes → these deps → actions.
import { useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind } from '../core/types'
import type { McpSession } from '../core/mcp'
import type { CatalogSkill } from '../core/skills'
import type { AddonApi } from '../core/addons'
import type { ConductorActions } from './actions'
import { dispatch } from '../core/store'
import { createSettingsActions } from '../domains/settings/actions'
import { createBoardActions } from '../domains/board/actions'
import { createSchedulesActions } from '../domains/schedules/actions'
import { createChatActions } from '../domains/chat/actions'
import { createAddonsActions } from '../domains/addons/actions'
import { createWorkspaceActions } from '../domains/workspace/actions'
import { createShellActions } from '../domains/shell/actions'
import { createSessionLayoutActions } from '../domains/session/layout-actions'
import { createSessionConfigActions } from '../domains/session/config-actions'
import { createMasterActions } from '../domains/master/actions'
import { createSessionController } from '../domains/session/controller'

export interface ConductorActionsDeps {
  stateRef: MutableRefObject<AppState>
  dragId: MutableRefObject<string | null>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  // integrations
  connectMcp: (id: string) => Promise<string>
  refreshSkillCatalog: (id: string) => Promise<string>
  mcpSessions: MutableRefObject<Map<string, McpSession>>
  skillCatalogs: MutableRefObject<Map<string, CatalogSkill[]>>
  // board / task
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  spawnSessionForTask: (taskId: string, workspaceId?: string) => void
  startTaskViaWatcher: (taskId: string) => void
  runWatcher: (taskId: string, note: string) => void
  pushTaskChat: (taskId: string, role: 'system' | 'user' | 'watcher', text: string) => void
  markUserStopped: (id: string) => void
  disposeWatcher: (taskId: string) => void
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
  launchFromTemplate: (templateId: string, task?: string) => string | null
  runChatMessage: (agentId: string, text: string, atts?: import('../domains/chat/runner').ChatAttachment[]) => void
  stopChatMessage: (agentId: string) => void
  retryChatMessage: (agentId: string) => void
  resetChatRuntime: (agentId: string) => void
  resolveChatApproval: (agentId: string, msgId: string, ok: boolean) => void
  // addons
  installPackage: (json: string, source: import('../core/types').Addon['source']) => void
  sendAddonChat: (id: string, text: string) => void
  makeAddonApi: (addonId: string) => AddonApi
  disposeAddon: (addonId: string) => void
  // workspace / master
  runMaster: (note?: string) => void
  disposeSessionRuntime: (id: string) => void
  abortMaster: () => void
  toolApprovals: MutableRefObject<Set<string>>
  // session
  armResponseWatch: (id: string) => void
  clearFlagged: (id: string) => void
  launchSession: (command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }) => string | null
  probeCliSession: (id: string, command: string, cwd: string, isResume: boolean) => void
  appendTail: (id: string, line: string) => void
  clearNeeds: (id: string) => void
  bumpSettle: (id: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
}

/** Plain (non-React) composition of every domain action slice into the single
 *  ConductorActions surface. The deps' methods are stable, so this is built once. */
export function createConductorActions(d: ConductorActionsDeps): ConductorActions {
  return {
    ...createSettingsActions({
      dispatch, later: d.later, connectMcp: d.connectMcp, refreshSkillCatalog: d.refreshSkillCatalog,
      mcpSessions: d.mcpSessions, skillCatalogs: d.skillCatalogs,
    }),
    ...createBoardActions({
      dispatch, stateRef: d.stateRef, dragId: d.dragId, later: d.later, flash: d.flash, logEvent: d.logEvent,
      fireAddonHook: d.fireAddonHook, spawnSessionForTask: d.spawnSessionForTask, startTaskViaWatcher: d.startTaskViaWatcher,
      runWatcher: d.runWatcher, pushTaskChat: d.pushTaskChat, markUserStopped: d.markUserStopped,
      disposeWatcher: d.disposeWatcher, taskSessions: d.taskSessions,
    }),
    ...createSchedulesActions({ dispatch, flash: d.flash, logEvent: d.logEvent, launchFromTemplate: d.launchFromTemplate }),
    ...createChatActions({
      dispatch, stateRef: d.stateRef, logEvent: d.logEvent, runChatMessage: d.runChatMessage,
      stopChatMessage: d.stopChatMessage, retryChatMessage: d.retryChatMessage,
      resetChatRuntime: d.resetChatRuntime, resolveChatApproval: d.resolveChatApproval, skillCatalogs: d.skillCatalogs,
    }),
    ...createAddonsActions({
      dispatch, stateRef: d.stateRef, flash: d.flash, installPackage: d.installPackage, sendAddonChat: d.sendAddonChat,
      makeAddonApi: d.makeAddonApi, disposeAddon: d.disposeAddon,
    }),
    ...createWorkspaceActions({
      dispatch, stateRef: d.stateRef, later: d.later, flash: d.flash, runMaster: d.runMaster,
      markUserStopped: d.markUserStopped, disposeSessionRuntime: d.disposeSessionRuntime, abortMaster: d.abortMaster,
    }),
    ...createShellActions(),
    ...createSessionLayoutActions(),
    ...createSessionConfigActions(),
    ...createMasterActions({ stateRef: d.stateRef, later: d.later, runMaster: d.runMaster, toolApprovals: d.toolApprovals }),
    // one controller owns the whole session process/terminal lifecycle
    ...createSessionController({
      stateRef: d.stateRef, flash: d.flash, logEvent: d.logEvent, markUserStopped: d.markUserStopped,
      disposeSessionRuntime: d.disposeSessionRuntime, launchSession: d.launchSession, probeCliSession: d.probeCliSession,
      armResponseWatch: d.armResponseWatch, appendTail: d.appendTail, clearNeeds: d.clearNeeds, bumpSettle: d.bumpSettle,
      clearFlagged: d.clearFlagged,
    }),
  }
}

export function useConductorActions(d: ConductorActionsDeps): ConductorActions {
  const ref = useRef<ConductorActions>(undefined)
  if (!ref.current) ref.current = createConductorActions(d)
  return ref.current
}
