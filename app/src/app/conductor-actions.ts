// Action composition: instantiate every domain action slice (memoizing each ctx
// on its stable callback/ref deps so the slices — and therefore ActionsCtx — stay
// referentially stable across state-driven re-renders) and merge them into the
// single ConductorActions surface. Pulled out of the provider so the composition
// root just wires runtimes → these deps → actions.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind } from '../core/types'
import type { McpSession } from '../core/mcp'
import type { CatalogSkill } from '../core/skills'
import type { AddonApi } from '../core/addons'
import type { ConductorActions } from './actions'
import { dispatch } from '../core/store'
import { useSettingsActions } from '../domains/settings/actions'
import { useBoardActions } from '../domains/board/actions'
import { useSchedulesActions } from '../domains/schedules/actions'
import { useChatActions } from '../domains/chat/actions'
import { useAddonsActions } from '../domains/addons/actions'
import { useWorkspaceActions } from '../domains/workspace/actions'
import { useShellActions } from '../domains/shell/actions'
import { useSessionLayoutActions } from '../domains/session/layout-actions'
import { useSessionConfigActions } from '../domains/session/config-actions'
import { useMasterActions } from '../domains/master/actions'
import { useSessionController } from '../domains/session/controller'

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
  runChatMessage: (agentId: string, text: string) => void
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

export function useConductorActions(d: ConductorActionsDeps): ConductorActions {
  const settingsActions = useSettingsActions(useMemo(() => ({
    dispatch, later: d.later, connectMcp: d.connectMcp, refreshSkillCatalog: d.refreshSkillCatalog,
    mcpSessions: d.mcpSessions, skillCatalogs: d.skillCatalogs,
  }), [d.later, d.connectMcp, d.refreshSkillCatalog, d.mcpSessions, d.skillCatalogs]))
  const boardActions = useBoardActions(useMemo(() => ({
    dispatch, stateRef: d.stateRef, dragId: d.dragId, later: d.later, flash: d.flash, logEvent: d.logEvent,
    fireAddonHook: d.fireAddonHook, spawnSessionForTask: d.spawnSessionForTask, startTaskViaWatcher: d.startTaskViaWatcher,
    runWatcher: d.runWatcher, pushTaskChat: d.pushTaskChat, markUserStopped: d.markUserStopped,
    disposeWatcher: d.disposeWatcher, taskSessions: d.taskSessions,
  }), [d.stateRef, d.dragId, d.later, d.flash, d.logEvent, d.fireAddonHook, d.spawnSessionForTask, d.startTaskViaWatcher, d.runWatcher, d.pushTaskChat, d.markUserStopped, d.disposeWatcher, d.taskSessions]))
  const schedulesActions = useSchedulesActions(useMemo(() => ({ dispatch, flash: d.flash, logEvent: d.logEvent, launchFromTemplate: d.launchFromTemplate }), [d.flash, d.logEvent, d.launchFromTemplate]))
  const chatActions = useChatActions(useMemo(() => ({ dispatch, stateRef: d.stateRef, logEvent: d.logEvent, runChatMessage: d.runChatMessage }), [d.stateRef, d.logEvent, d.runChatMessage]))
  const addonsActions = useAddonsActions(useMemo(() => ({
    dispatch, stateRef: d.stateRef, flash: d.flash, installPackage: d.installPackage, sendAddonChat: d.sendAddonChat,
    makeAddonApi: d.makeAddonApi, disposeAddon: d.disposeAddon,
  }), [d.stateRef, d.flash, d.installPackage, d.sendAddonChat, d.makeAddonApi, d.disposeAddon]))
  const workspaceActions = useWorkspaceActions(useMemo(() => ({
    dispatch, stateRef: d.stateRef, later: d.later, flash: d.flash, runMaster: d.runMaster,
    markUserStopped: d.markUserStopped, disposeSessionRuntime: d.disposeSessionRuntime, abortMaster: d.abortMaster,
  }), [d.stateRef, d.later, d.flash, d.runMaster, d.markUserStopped, d.disposeSessionRuntime, d.abortMaster]))
  const shellActions = useShellActions()
  const sessionLayoutActions = useSessionLayoutActions()
  const sessionConfigActions = useSessionConfigActions()
  const masterActions = useMasterActions(useMemo(() => ({
    stateRef: d.stateRef, later: d.later, runMaster: d.runMaster, toolApprovals: d.toolApprovals,
  }), [d.stateRef, d.later, d.runMaster, d.toolApprovals]))
  // one controller owns the whole session process/terminal lifecycle
  const sessionController = useSessionController(useMemo(() => ({
    stateRef: d.stateRef, flash: d.flash, logEvent: d.logEvent, markUserStopped: d.markUserStopped,
    disposeSessionRuntime: d.disposeSessionRuntime, launchSession: d.launchSession, probeCliSession: d.probeCliSession,
    armResponseWatch: d.armResponseWatch, appendTail: d.appendTail, clearNeeds: d.clearNeeds, bumpSettle: d.bumpSettle,
    clearFlagged: d.clearFlagged,
  }), [d.stateRef, d.flash, d.logEvent, d.markUserStopped, d.disposeSessionRuntime, d.launchSession, d.probeCliSession, d.armResponseWatch, d.appendTail, d.clearNeeds, d.bumpSettle, d.clearFlagged]))

  return useMemo<ConductorActions>(() => ({
    ...settingsActions, ...boardActions, ...schedulesActions, ...chatActions, ...addonsActions,
    ...workspaceActions, ...shellActions, ...sessionLayoutActions, ...sessionConfigActions,
    ...sessionController, ...masterActions,
  }), [settingsActions, boardActions, schedulesActions, chatActions, addonsActions, workspaceActions, shellActions, sessionLayoutActions, sessionConfigActions, sessionController, masterActions])
}
