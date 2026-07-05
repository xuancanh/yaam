// Runtime wiring: instantiate every domain runtime (monitor/watcher/chat/master/
// addon-agent), the session helpers (attention/settle/launch/exit/dispose), the
// scheduler, persistence/boot, integrations, and the addon API — cross-wired
// through the declaration-cycle refs. Takes the provider's foundation kernel and
// returns exactly the deps the action composition needs. Pulled out of the
// provider so ConductorProvider stays a thin composition root.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { AddonHookName, AppState, EventType, NotifKind } from './../core/types'
import type { ApiMessage } from '../master'
import type { AddonApi } from '../core/addons'
import { enforcePermissions, execAddonHook } from '../core/addons'
import { dispatch, useAppStore } from '../core/store'
import { createMonitorRuntime } from '../domains/master/monitor-runtime'
import type { MonitorRuntime } from '../domains/master/monitor-runtime'
import { createWatcherRuntime } from '../domains/board/watcher-runtime'
import type { WatcherRuntime } from '../domains/board/watcher-runtime'
import { createChatRuntime } from '../domains/chat/chat-runtime'
import type { ChatRuntime } from '../domains/chat/chat-runtime'
import { createMasterRuntime } from '../domains/master/master-runtime'
import type { MasterRuntime } from '../domains/master/master-runtime'
import { createAddonAgentRuntime } from '../domains/addons/agent-runtime'
import type { AddonAgentRuntime } from '../domains/addons/agent-runtime'
import { useAddonRuntime } from '../domains/addons/runtime'
import { useIntegrationRuntime } from '../domains/settings/integrations'
import { useLaunchRuntime } from '../domains/session/launch-runtime'
import { useSessionAttention } from '../domains/session/attention'
import { useChatLog } from '../domains/chat/log'
import { useChatSearchIndexer } from '../domains/chat/search-indexer'
import { useSessionExitHandler } from '../domains/session/exit-handler'
import { useSchedulerRuntime } from '../domains/schedules/runtime'
import { useSessionSettle } from '../domains/session/use-settle'
import { useHydration } from '../infrastructure/persistence/hydrate-effect'
import { createPersistenceRuntime } from '../infrastructure/persistence/runtime'
import type { PersistenceRuntime } from '../infrastructure/persistence/runtime'
import { createAddonApi } from '../domains/addons/addon-api'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from '../domains/board/task-state'
import type { LocatedTask } from '../domains/board/task-state'
import { disposeTerminal } from '../core/terminals'
import { mkId } from '../shared/id'
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
  const { stateRef, later, flash, widOf, logEvent, notify } = k

  // declaration-cycle refs: set once their targets exist below
  const masterEventRef = useRef<(note: string, agentId?: string) => void>(() => {})
  const monitorEventRef = useRef<(id: string, note: string) => Promise<void> | void>(() => {})
  const fireAddonHookRef = useRef<(hook: AddonHookName, event: Record<string, unknown>) => void>(() => {})
  const runAddonAgentRef = useRef<(addonId: string, note: string) => Promise<string>>(async () => 'agent not ready')
  const runWatcherRef = useRef<(taskId: string, note: string) => void>(() => {})
  const spawnTaskSessionRef = useRef<(taskId: string, extraInstructions?: string) => string | null>(() => null)
  const startIntegrationsRef = useRef<() => void>(() => {})
  /** sessions the user stopped via ■ — their exit is a STOP, not a completion */
  const userStoppedRef = useRef<Set<string>>(new Set())
  /** one-shot user approvals for Ask-first Master tools (consumed on use) */
  const toolApprovalsRef = useRef<Set<string>>(new Set())
  /** fast task→session bindings before React commits agentId */
  const taskSessionsRef = useRef<Map<string, { taskId: string; workspaceId: string }>>(new Map())

  // session output/status/prompt helpers (clearNeeds stays below — needs clearFlagged)
  const { sessionScreenTail, setNeedsInput, applyAgentStatus, appendTail } = useSessionAttention(useMemo(() => ({
    stateRef, widOf, logEvent, notify,
    fireAddonHook: (hook: AddonHookName, event: Record<string, unknown>) => fireAddonHookRef.current(hook, event),
  }), [stateRef, widOf, logEvent, notify]))

  // monitor runtime (owns its registries + disposal)
  const monitorRef = useRef<MonitorRuntime>(undefined)
  if (!monitorRef.current) {
    monitorRef.current = createMonitorRuntime({
      stateRef, dispatch, applyAgentStatus, setNeedsInput, logEvent, notify,
      masterEvent: (n, a) => masterEventRef.current(n, a),
    })
  }
  const runMonitor = monitorRef.current.run
  monitorEventRef.current = (id, note) => runMonitor(id, note)

  // Resolve fast launch bindings before reducer state has committed agentId.
  const taskForSession = useCallback((sessionId: string): LocatedTask | undefined => {
    const binding = taskSessionsRef.current.get(sessionId)
    return binding
      ? findTaskInState(stateRef.current, binding.taskId, binding.workspaceId)
      : findTaskForAgentInState(stateRef.current, sessionId)
  }, [stateRef])

  const pushTaskChat = useCallback((taskId: string, role: import('../core/types').TaskChatMsg['role'], text: string) => {
    dispatch(s => updateLocatedTask(s, taskId, t => ({
      ...t,
      chat: (t.chat ?? []).concat([{ id: mkId('tc'), role, text, at: Date.now() }]).slice(-80),
    })))
  }, [])

  // watcher runtime (owns per-task registries + disposal)
  const watcherRef = useRef<WatcherRuntime>(undefined)
  if (!watcherRef.current) {
    watcherRef.current = createWatcherRuntime({
      stateRef, dispatch, taskSessions: taskSessionsRef, applyAgentStatus, pushTaskChat, logEvent, notify,
      fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
      spawnTaskSession: (id, extra) => spawnTaskSessionRef.current(id, extra),
    })
  }
  const runWatcher = watcherRef.current.run
  runWatcherRef.current = (taskId, note) => { void runWatcher(taskId, note) }

  // settle/prompt watcher + clear-on-user-input
  const { armResponseWatch, bumpSettle, clearFlagged, disposeSettle } = useSessionSettle({
    stateRef, later, notify, setNeedsInput, runMonitor, taskForSession,
    masterEventRef, monitorEventRef, runWatcherRef,
  })
  const clearNeeds = useCallback((id: string) => {
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
  }, [clearFlagged])

  useSessionExitHandler(useMemo(() => ({
    stateRef,
    takeUserStopped: (id: string) => userStoppedRef.current.delete(id),
    taskForSession, pushTaskChat, logEvent, notify,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    runWatcher: (taskId: string, note: string) => runWatcherRef.current(taskId, note),
    monitorEvent: (id: string, note: string) => monitorEventRef.current(id, note),
  }), [stateRef, taskForSession, pushTaskChat, logEvent, notify]))

  // persistence save-side runtime + boot/hydration
  const persistenceRef = useRef<PersistenceRuntime | undefined>(undefined)
  if (!persistenceRef.current) {
    persistenceRef.current = createPersistenceRuntime(
      { getState: useAppStore.getState, subscribe: useAppStore.subscribe },
      { onToast: msg => dispatch(s => ({ ...s, toast: msg })) },
    )
  }
  const persistence = persistenceRef.current
  useHydration(useMemo(() => ({
    stateRef, persistence, startIntegrations: () => startIntegrationsRef.current(),
    appendTail, clearNeeds, bumpSettle, armResponseWatch,
  }), [stateRef, persistence, appendTail, clearNeeds, bumpSettle, armResponseWatch]))
  useEffect(() => {
    persistence.start()
    return () => persistence.dispose()
  }, [persistence])

  // session/task launch runtime
  const { probeCliSession, launchSession, launchFromTemplate, spawnTaskSession, spawnSessionForTask, startTaskViaWatcher } = useLaunchRuntime(useMemo(() => ({
    stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch,
    pushTaskChat, runWatcher, taskSessions: taskSessionsRef,
  }), [stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch, pushTaskChat, runWatcher]))
  spawnTaskSessionRef.current = (taskId, extraInstructions) => spawnTaskSession(taskId, { extraInstructions })

  // addon API (permission-scoped) + per-addon agent runtime
  const makeAddonApiRaw = useCallback((addonId: string): AddonApi => createAddonApi({
    stateRef, dispatch,
    launchSession: (command, cwd, name) => launchSession(command, cwd, name),
    launchFromTemplate: (templateId, task) => launchFromTemplate(templateId, task),
    spawnSessionForTask: id => spawnSessionForTask(id),
    pushTaskChat, flash,
    logEvent: text => logEvent('edit', null, text),
    notify: (title, detail) => notify('done', title, detail, null),
    later,
    markUserStopped: id => userStoppedRef.current.add(id),
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    runWatcher: (taskId, note) => runWatcherRef.current(taskId, note),
    wakeAgent: (aid, note) => runAddonAgentRef.current(aid, note),
  }, addonId), [stateRef, flash, later, launchFromTemplate, launchSession, logEvent, notify, pushTaskChat, spawnSessionForTask])
  const makeAddonApi = useCallback((addonId: string): AddonApi => {
    const addon = stateRef.current.addons.find(a => a.id === addonId)
    return enforcePermissions(makeAddonApiRaw(addonId), addon?.enabled ? addon.granted : [])
  }, [stateRef, makeAddonApiRaw])

  const addonEditorHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const addonAgentRef = useRef<AddonAgentRuntime>(undefined)
  if (!addonAgentRef.current) {
    addonAgentRef.current = createAddonAgentRuntime({ stateRef, logEvent, makeAddonApi })
  }
  const runAddonAgent = addonAgentRef.current.run
  runAddonAgentRef.current = runAddonAgent
  const disposeAddon = useCallback((id: string) => {
    addonAgentRef.current!.dispose(id)
    addonEditorHistories.current.delete(id)
  }, [])

  // chat runtime + integrations + session teardown + chat log/search
  const chatRef = useRef<ChatRuntime>(undefined)
  const { mcpSessions, skillCatalogs, connectMcp, refreshSkillCatalog } = useIntegrationRuntime(stateRef)
  const disposeSessionRuntime = useCallback((id: string) => {
    disposeTerminal(id)
    disposeSettle(id)
    monitorRef.current!.dispose(id)
    chatRef.current!.dispose(id)
    taskSessionsRef.current.delete(id)
  }, [disposeSettle])
  const { updateChatLog, pushChatLog } = useChatLog()
  useChatSearchIndexer(stateRef)
  startIntegrationsRef.current = () => {
    for (const srv of stateRef.current.mcpServers) if (srv.enabled) void connectMcp(srv.id)
    for (const reg of stateRef.current.skillRegistries) if (reg.enabled) void refreshSkillCatalog(reg.id)
  }
  if (!chatRef.current) {
    chatRef.current = createChatRuntime({
      stateRef, dispatch, mcpSessions, skillCatalogs, pushChatLog, updateChatLog, flash, refreshSkillCatalog,
    })
  }
  const runChatMessage = chatRef.current.run

  // addon lifecycle-hook fan-out (also wakes hook-subscribing addon agents)
  const fireAddonHook = useCallback((hook: AddonHookName, event: Record<string, unknown>) => {
    void execAddonHook(stateRef.current, hook, event, makeAddonApi)
    for (const a of stateRef.current.addons) {
      if (a.enabled && a.agent?.on?.includes(hook)) {
        void runAddonAgent(a.id, `[${hook}] ${JSON.stringify(event)}\n\nReact per your instructions; do nothing if this event is irrelevant.`)
      }
    }
  }, [stateRef, makeAddonApi, runAddonAgent])
  fireAddonHookRef.current = fireAddonHook

  // cron + scheduled-task ticker
  useSchedulerRuntime(useMemo(() => ({
    stateRef, logEvent, notify, launchSession, spawnTaskSession,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
  }), [stateRef, logEvent, notify, launchSession, spawnTaskSession]))

  // Master runtime (owns its loop state) + proactive-event routing
  const masterRef = useRef<MasterRuntime>(undefined)
  if (!masterRef.current) {
    masterRef.current = createMasterRuntime({
      stateRef, dispatch, toolApprovalsRef, userStoppedRef,
      disposeAddon, launchSession, launchFromTemplate, armResponseWatch,
      sessionScreenTail, logEvent, flash, applyAgentStatus, setNeedsInput, makeAddonApi,
    })
  }
  const runMaster = masterRef.current.run
  masterEventRef.current = (note, agentId) => {
    const s = stateRef.current
    const wid = widOf(s, agentId ?? null)
    if (wid === s.activeWorkspace) { void runMaster(note); return }
    dispatch(s2 => {
      const d = s2.workspaceData[wid]
      if (!d) return s2
      return { ...s2, workspaceData: { ...s2.workspaceData, [wid]: { ...d, pendingMasterNotes: d.pendingMasterNotes.concat([note]).slice(-10) } } }
    })
  }

  // per-addon customization chat (editor turns) + package install
  const addonRuntime = useAddonRuntime(useMemo(() => ({
    stateRef, flash, logEvent, editorHistories: addonEditorHistories,
  }), [stateRef, flash, logEvent]))

  return {
    connectMcp, refreshSkillCatalog, mcpSessions, skillCatalogs,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    spawnSessionForTask, startTaskViaWatcher, runWatcher, pushTaskChat,
    markUserStopped: (id: string) => userStoppedRef.current.add(id),
    disposeWatcher: (tid: string) => watcherRef.current!.dispose(tid), taskSessions: taskSessionsRef,
    launchFromTemplate: (templateId: string, task?: string) => launchFromTemplate(templateId, task),
    runChatMessage,
    installPackage: addonRuntime.installPackage,
    sendAddonChat: (id: string, text: string) => { void addonRuntime.sendAddonChat(id, text) },
    makeAddonApi, disposeAddon,
    runMaster, disposeSessionRuntime, abortMaster: () => masterRef.current!.abort(),
    toolApprovals: toolApprovalsRef,
    armResponseWatch, clearFlagged, launchSession, probeCliSession, appendTail, clearNeeds, bumpSettle,
  }
}
