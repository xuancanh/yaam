/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  AddonHookName, BoardTask, LogLine,
  PersistedState, TaskChatMsg,
} from './core/types'
import * as native from './core/native'
import { buildCfg, hasCreds } from './master'
import type { ApiMessage } from './master'
import { disposeTerminal, getTerminal, repaintSession } from './core/terminals'
import { enforcePermissions, execAddonHook } from './core/addons'
import { runAddonAgentTurn } from './domains/addons/addon-agent'
import type { AddonApi } from './core/addons'
import { ActionsCtx } from './core/context'
import { dispatch, useAppStore } from './core/store'
import { runMonitorLoop } from './domains/master/monitor-runner'
import { runWatcherLoop } from './domains/board/watcher-runner'
import { runChatMessageTurn } from './domains/chat/runner'
import { runMasterLoop } from './domains/master/runner'
import { useSettingsActions } from './domains/settings/actions'
import { useBoardActions } from './domains/board/actions'
import { useSchedulesActions } from './domains/schedules/actions'
import { useChatActions } from './domains/chat/actions'
import { useAddonsActions } from './domains/addons/actions'
import { useWorkspaceActions } from './domains/workspace/actions'
import { useShellActions } from './domains/shell/actions'
import { useSessionLayoutActions } from './domains/session/layout-actions'
import { useSessionConfigActions } from './domains/session/config-actions'
import { useSessionPromptActions } from './domains/session/prompt-actions'
import { useMasterActions } from './domains/master/actions'
import { useSessionActions } from './domains/session/actions'
import { useActivityService } from './domains/activity/service'
import { useAddonRuntime } from './domains/addons/runtime'
import { useIntegrationRuntime } from './domains/settings/integrations'
import { useLaunchRuntime } from './domains/session/launch-runtime'
import { useSessionAttention } from './domains/session/attention'
import { useChatLog } from './domains/chat/log'
import { useChatSearchIndexer } from './domains/chat/search-indexer'
import { useSessionExitHandler } from './domains/session/exit-handler'
import { createAddonApi } from './domains/addons/addon-api'
import { applyResolvedSecrets, secretEntries } from './store/secrets'
import { AbortRegistry, isAbortError } from './core/abort-registry'
import { useSessionSettle } from './domains/session/use-settle'
import { buildHydration } from './infrastructure/persistence/hydrate'
import { loadSnapshot } from './infrastructure/persistence/loaders'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from './domains/board/task-state'
import type { LocatedTask } from './domains/board/task-state'
import type { ConductorActions } from './app/actions'



import { mkId } from './shared/id'
import { createPersistenceRuntime } from './infrastructure/persistence/runtime'
import type { PersistenceRuntime } from './infrastructure/persistence/runtime'
import { collectDueSchedules, collectDueTasks } from './domains/schedules/due'

export { cronMatches, humanizeCron } from './domains/schedules/cron'

/** Own the complete app state, native/LLM effects, and action surface for the UI. */
export function ConductorProvider({ children }: { children: ReactNode }) {
  // State lives in the Zustand store; the provider subscribes to the whole
  // state (so its state-dep effects re-run and stateRef stays fresh) and drives
  // updates through `dispatch`. Selector consumers (useConductorSelector) get
  // Zustand's per-slice subscriptions instead.
  // The provider is a pure composition root: it renders only <ActionsCtx> and
  // reads state through stateRef in callbacks/effects, so it must NOT subscribe
  // to the whole store (that would re-render it on every terminal line and chat
  // delta). stateRef is mirrored from the store via a direct subscription; UI
  // reads reactive state through useConductorSelector in the components.
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(useAppStore.getState())
  useEffect(() => useAppStore.subscribe(next => { stateRef.current = next }), [])

  // set by the Master/monitor runners below; refs avoid declaration cycles
  const masterEventRef = useRef<(note: string, agentId?: string) => void>(() => {})
  const monitorEventRef = useRef<(id: string, note: string) => Promise<void> | void>(() => {})

  useEffect(() => {
    const timers = pending.current
    return () => {
      timers.forEach(t => window.clearTimeout(t))
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  // Schedule a tracked timeout so provider unmount can cancel outstanding work.
  // The id is removed once it fires so the tracking array can't grow without
  // bound over a long-lived session (Master turns, watchers, etc. call this a lot).
  const later = useCallback((ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      const i = pending.current.indexOf(id)
      if (i !== -1) pending.current.splice(i, 1)
      fn()
    }, ms)
    pending.current.push(id)
  }, [])

  // Replace the transient toast and clear it after a short display window.
  const flash = useCallback((t: string) => {
    dispatch(s => ({ ...s, toast: t }))
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => dispatch(s => ({ ...s, toast: null })), 2600)
  }, [])

  // events/notifications land in the OWNING workspace (sessions in background
  // workspaces keep reporting into their own stash)
  const { widOf, logEvent, notify } = useActivityService()

  // Agents → Master / user leg. We never react to individual lines: each
  // session has a settle watcher, and only once output has been quiet for a
  // few seconds do we look at the tail. If the LLM Master is enabled, IT
  // decides whether the session is waiting on the user (flag_needs_input);
  // without it, a prompt-shaped final line is required.
  // Prefer the rendered screen for TUI context and fall back to retained log lines.
  // Session output/status/prompt helpers (domains/session/attention). clearNeeds
  // stays below — it needs the settle watcher's clearFlagged.
  const { sessionScreenTail, setNeedsInput, applyAgentStatus, appendTail } = useSessionAttention(useMemo(() => ({
    stateRef, widOf, logEvent, notify,
    fireAddonHook: (hook: AddonHookName, event: Record<string, unknown>) => fireAddonHookRef.current(hook, event),
  }), [widOf, logEvent, notify]))

  // ref: setNeedsInput is declared before the hook runner
  const fireAddonHookRef = useRef<(hook: AddonHookName, event: Record<string, unknown>) => void>(() => {})
  const runAddonAgentRef = useRef<(addonId: string, note: string) => Promise<string>>(async () => 'agent not ready')
  /** sessions the user stopped via ■ — their exit is a STOP, not a completion/failure */
  const userStoppedRef = useRef<Set<string>>(new Set())
  /** one-shot user approvals for Ask-first Master tools (consumed on use) */
  const toolApprovalsRef = useRef<Set<string>>(new Set())

  // shared by Master's update_agent_status tool and the per-session monitors
  // Per-session monitor LLMs: private history + serialized turns per session.
  // They digest terminal output locally; Master only sees report_to_master.
  const monitorHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const monitorBusy = useRef<Set<string>>(new Set())
  const monitorQueue = useRef<Map<string, string>>(new Map())
  // per-session cancellation for in-flight monitor turns (aborted on dispose)
  const monitorAborts = useRef(new AbortRegistry())

  // Serialize private monitor turns per session (loop body in store/monitor-runner).
  const runMonitor = useCallback((id: string, note: string) => runMonitorLoop({
    stateRef, dispatch, histories: monitorHistories, busy: monitorBusy, queue: monitorQueue,
    aborts: monitorAborts.current,
    applyAgentStatus, setNeedsInput, logEvent, notify,
    masterEvent: (n, a) => masterEventRef.current(n, a),
  }, id, note), [applyAgentStatus, logEvent, notify, setNeedsInput])

  monitorEventRef.current = (id, note) => runMonitor(id, note)

  // ---- per-task watcher: a mini Master owning one kanban task ----
  const watcherHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const watcherBusy = useRef<Set<string>>(new Set())
  const watcherQueue = useRef<Map<string, string[]>>(new Map())
  // per-task cancellation for in-flight watcher turns (aborted on task delete)
  const watcherAborts = useRef(new AbortRegistry())
  const runWatcherRef = useRef<(taskId: string, note: string) => void>(() => {})
  // Set synchronously when a task launches a session. This closes the small
  // gap before React commits task.agentId, during which a fast one-shot can exit.
  const taskSessionsRef = useRef<Map<string, { taskId: string; workspaceId: string }>>(new Map())
  // set below once the launch helpers exist; the watcher exec needs it earlier
  const spawnTaskSessionRef = useRef<(taskId: string, extraInstructions?: string) => string | null>(() => null)

  // Resolve fast launch bindings before reducer state has committed agentId.
  const taskForSession = useCallback((sessionId: string): LocatedTask | undefined => {
    const binding = taskSessionsRef.current.get(sessionId)
    return binding
      ? findTaskInState(stateRef.current, binding.taskId, binding.workspaceId)
      : findTaskForAgentInState(stateRef.current, sessionId)
  }, [])

  // Append a bounded message to a task watcher's visible chat.
  const pushTaskChat = useCallback((taskId: string, role: TaskChatMsg['role'], text: string) => {
    dispatch(s => updateLocatedTask(s, taskId, t => ({
      ...t,
      chat: (t.chat ?? []).concat([{ id: mkId('tc'), role, text, at: Date.now() }]).slice(-80),
    })))
  }, [])

  // Serialize watcher turns per task and drain notes that arrive while one is running.
  const runWatcher = useCallback((taskId: string, note: string) => runWatcherLoop({
    stateRef, dispatch, histories: watcherHistories, busy: watcherBusy, queue: watcherQueue,
    aborts: watcherAborts.current,
    taskSessions: taskSessionsRef, applyAgentStatus, pushTaskChat, logEvent, notify,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    spawnTaskSession: (id, extra) => spawnTaskSessionRef.current(id, extra),
  }, taskId, note), [applyAgentStatus, logEvent, notify, pushTaskChat])

  runWatcherRef.current = (taskId, note) => { void runWatcher(taskId, note) }

  // Session settle/prompt watcher (armed snapshots, quiet timers, dialog scan)
  // lives in the session domain; the provider supplies state + fan-out refs.
  const { armResponseWatch, bumpSettle, clearFlagged, disposeSettle } = useSessionSettle({
    stateRef, later, notify, setNeedsInput, runMonitor, taskForSession,
    masterEventRef, monitorEventRef, runWatcherRef,
  })

  // typing into a terminal clears its "needs action" state
  // Clear a session's prompt state after the user or Master answers it.
  // The user typed into the terminal — they are handling it themselves, so
  // dismiss everything we asked of them: needs status, the card's pending
  // action, and any open approval card in the Master chat.
  const clearNeeds = useCallback((id: string) => {
    clearFlagged(id)
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? {
            ...a,
            attention: false,
            actionNeeded: undefined,
            ...(a.status === 'needs' ? { status: 'running' as const, escReason: undefined } : {}),
          }
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
  }), [taskForSession, pushTaskChat, logEvent, notify]))


  // persistence: restore everything (including session definitions and their
  // output tails) on launch, save on change. Restored sessions come back
  // paused — resume respawns their command.
  // the save-side persistence runtime (created once in render, below). Hydration
  // seeds its keychain-ready set and calls markReady() when the snapshot applies.
  const persistenceRef = useRef<PersistenceRuntime | undefined>(undefined)
  const hydrateStarted = useRef(false)
  // connect enabled MCP/skill integrations once hydration has actually finished.
  // Set below (after connectMcp/refreshSkillCatalog exist) and invoked from the
  // hydration effect — no fixed-delay timer racing disk/keychain load (finding #3).
  const startIntegrationsRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (hydrateStarted.current) return
    hydrateStarted.current = true
    // Apply one merged snapshot: dispatch the pure hydration result, then rebuild
    // terminals. Throws if not usable so the caller can fall back / start fresh.
    const hydrateFrom = (p: Partial<PersistedState>) => {
          const { next, restoredAgents } = buildHydration(p, stateRef.current)
          dispatch(() => next)
          // rebuild each restored session's terminal with its saved tail, and
          // reattach to PTYs that are still alive in the backend (webview reload)
          native.liveSessions().then(liveIds => {
            const alive = new Set(liveIds)
            for (const a of restoredAgents) {
              const { term } = getTerminal(a.id, line => appendTail(a.id, line), () => clearNeeds(a.id), () => bumpSettle(a.id), () => armResponseWatch(a.id))
              if (alive.has(a.id)) {
                // live PTY: never inject text (it corrupts TUI screens) —
                // nudge the app to repaint itself once the pane has mounted
                window.setTimeout(() => repaintSession(a.id), 1200)
              } else {
                for (const l of a.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
                term.writeln('\x1b[33m── restored from previous run · press ▶ to relaunch ──\x1b[0m')
              }
            }
            if (alive.size) {
              dispatch(s2 => ({
                ...s2,
                agents: s2.agents.map(a => alive.has(a.id)
                  ? { ...a, status: 'running' as const, log: a.log.concat([{ t: 'sys' as const, x: 'reattached · session still running' }]) }
                  : a),
              }))
            }
          }).catch(() => {})
    }
    void (async () => {
      try {
        const { merged, usedBackup } = await loadSnapshot()
        if (usedBackup) dispatch(s => ({ ...s, toast: 'Restored from backup — the main state file was unreadable' }))
        // start-fresh unless there is something worth restoring
        if (Object.keys(merged).some(k => k !== 'agents') || merged.agents?.length) hydrateFrom(merged)
      } catch (e) {
        console.error('[yaam] hydration failed — starting fresh:', e)
        dispatch(s => ({ ...s, toast: 'Saved state was unreadable — starting fresh' }))
      }
      // fill credential fields the file no longer holds from the OS keychain,
      // and mark anything already present (legacy plaintext) as keychain-bound
      // once the sync effect writes it
      try {
        const resolved: Record<string, string> = {}
        for (const { account, value } of secretEntries(stateRef.current)) {
          if (value) continue // legacy plaintext still in the loaded file
          const v = await native.secretGet(account)
          if (v) { resolved[account] = v; persistenceRef.current!.keychainReady.add(account) }
        }
        if (Object.keys(resolved).length) dispatch(s => applyResolvedSecrets(s, resolved))
      } catch (e) {
        console.error('[yaam] keychain resolve failed:', e)
      }
      // restored state is fully applied — enable saves, then connect integrations
      persistenceRef.current!.markReady()
      startIntegrationsRef.current()
    })()
  }, [appendTail, armResponseWatch, bumpSettle, clearNeeds])

  // All save-side persistence (debounced main/session writers, keychain mirror,
  // teardown flush, save-error state) lives in a dedicated runtime that subscribes
  // to the store directly. Created once during render so the hydration effect can
  // seed its keychain set and call markReady() when the restored snapshot is applied.
  if (!persistenceRef.current) {
    persistenceRef.current = createPersistenceRuntime(
      { getState: useAppStore.getState, subscribe: useAppStore.subscribe },
      { onToast: msg => dispatch(s => ({ ...s, toast: msg })) },
    )
  }
  const persistence = persistenceRef.current
  useEffect(() => {
    persistence.start()
    return () => persistence.dispose()
  }, [persistence])

  // Session/task launch + CLI resume-id probing (domains/session/launch-runtime).
  const { probeCliSession, launchSession, launchFromTemplate, spawnTaskSession, spawnSessionForTask, startTaskViaWatcher } = useLaunchRuntime(useMemo(() => ({
    stateRef, later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch,
    pushTaskChat, runWatcher, taskSessions: taskSessionsRef,
  }), [later, flash, logEvent, appendTail, clearNeeds, bumpSettle, armResponseWatch, pushTaskChat, runWatcher]))
  spawnTaskSessionRef.current = (taskId, extraInstructions) => spawnTaskSession(taskId, { extraInstructions })

  // API surface handed to addon code (tools, hooks, and view RPC) — scoped
  // per addon so storage is namespaced
  // Build the unguarded addon API implementation scoped to one addon's storage.
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
  }, addonId), [flash, later, launchFromTemplate, launchSession, logEvent, notify, pushTaskChat, spawnSessionForTask])

  // Wrap an addon's raw API with its current permission grants.
  const makeAddonApi = useCallback((addonId: string): AddonApi => {
    const addon = stateRef.current.addons.find(a => a.id === addonId)
    return enforcePermissions(makeAddonApiRaw(addonId), addon?.enabled ? addon.granted : [])
  }, [makeAddonApiRaw])

  // ---- per-addon LLM agents: an addon's own mini-Master, tools = its API ----
  const addonAgentHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const addonAgentBusy = useRef<Set<string>>(new Set())
  // per-addon cancellation for in-flight agent turns (aborted when the addon is removed)
  const addonAborts = useRef(new AbortRegistry())

  const runAddonAgent = useCallback(async (addonId: string, note: string): Promise<string> => {
    const st = stateRef.current.settings
    const addon = stateRef.current.addons.find(a => a.id === addonId)
    if (!addon?.agent) return 'this addon declares no agent'
    if (!addon.enabled) return 'addon is disabled'
    if (!(st.masterEnabled && hasCreds(st))) return 'no brain configured — enable LLM Master in Settings'
    if (addonAgentBusy.current.has(addonId)) return 'agent is busy with a previous note — try again shortly'
    addonAgentBusy.current.add(addonId)
    try {
      let history = addonAgentHistories.current.get(addonId)
      if (!history) {
        history = []
        addonAgentHistories.current.set(addonId, history)
      }
      const reply = await runAddonAgentTurn(buildCfg(st, st.monitorModel || undefined), addon, note, history, makeAddonApi(addonId), addonAborts.current.signal(addonId))
      return reply || '(acted without a reply)'
    } catch (e) {
      // the addon was removed mid-turn — stop quietly
      if (isAbortError(e) || addonAborts.current.signal(addonId).aborted) return 'agent cancelled'
      const msg = e instanceof Error ? e.message : String(e)
      logEvent('escalate', null, `Addon agent "${addon.name}" error: ${msg}`)
      return `agent error: ${msg}`
    } finally {
      addonAgentBusy.current.delete(addonId)
      addonAborts.current.clear(addonId)
    }
  }, [logEvent, makeAddonApi])

  runAddonAgentRef.current = runAddonAgent

  // ---- chat-mode sessions: Claude-Desktop-style agents living in panes ----
  const chatHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const chatBusy = useRef<Set<string>>(new Set())
  // per-chat cancellation for in-flight replies (aborted when the chat is deleted)
  const chatAborts = useRef(new AbortRegistry())
  const { mcpSessions: mcpSessionsRef, skillCatalogs: skillCatalogsRef, connectMcp, refreshSkillCatalog } = useIntegrationRuntime(stateRef)

  // Tear down ALL per-session runtime state in one place: the xterm instance
  // (and its 5k-line scrollback), the settle timer, and the monitor/chat/task
  // registries keyed by session id. Called on delete, archive, and workspace
  // removal so nothing leaks past a session's visible lifetime.
  const disposeSessionRuntime = useCallback((id: string) => {
    disposeTerminal(id)
    disposeSettle(id)
    monitorAborts.current.abort(id) // cancel any in-flight monitor turn for this session
    chatAborts.current.abort(id) // cancel any in-flight chat reply for this session
    monitorHistories.current.delete(id)
    monitorBusy.current.delete(id)
    monitorQueue.current.delete(id)
    chatHistories.current.delete(id)
    chatBusy.current.delete(id)
    taskSessionsRef.current.delete(id)
  }, [disposeSettle])

  // Replace the text of one existing chat message (streaming updates).
  const { updateChatLog, pushChatLog } = useChatLog()
  // keep the embedded chat search index in sync with transcripts (self-contained)
  useChatSearchIndexer(stateRef)

  // connect enabled MCP servers + skill registries; invoked by the hydration
  // effect the moment restored state is applied (gated on real completion, not a
  // fixed 1.5s timer that could observe seed state on slow disk/keychain loads).
  startIntegrationsRef.current = () => {
    for (const srv of stateRef.current.mcpServers) if (srv.enabled) void connectMcp(srv.id)
    for (const reg of stateRef.current.skillRegistries) if (reg.enabled) void refreshSkillCatalog(reg.id)
  }

  const runChatMessage = useCallback((agentId: string, text: string) => runChatMessageTurn({
    stateRef, dispatch, busy: chatBusy, aborts: chatAborts.current, histories: chatHistories, mcpSessions: mcpSessionsRef,
    skillCatalogs: skillCatalogsRef, pushChatLog, updateChatLog, flash, refreshSkillCatalog,
  }, agentId, text), [flash, pushChatLog, refreshSkillCatalog, updateChatLog])

  // Run one lifecycle hook for each enabled addon without blocking the caller;
  // addons whose agent subscribes to the hook get woken with the event too.
  const fireAddonHook = useCallback((hook: AddonHookName, event: Record<string, unknown>) => {
    void execAddonHook(stateRef.current, hook, event, makeAddonApi)
    for (const a of stateRef.current.addons) {
      if (a.enabled && a.agent?.on?.includes(hook)) {
        void runAddonAgent(a.id, `[${hook}] ${JSON.stringify(event)}\n\nReact per your instructions; do nothing if this event is irrelevant.`)
      }
    }
  }, [makeAddonApi, runAddonAgent])

  fireAddonHookRef.current = fireAddonHook

  // cron scheduler: fire enabled schedules once per matching minute
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = new Date()
      const minuteKey = now.toISOString().slice(0, 16)
      const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const st = stateRef.current
      // schedules fire in every workspace, active or not
      const pools: Array<{ wid: string; crons: typeof st.crons }> = [
        { wid: st.activeWorkspace, crons: st.crons },
        ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, crons: d.crons })),
      ]
      for (const pool of pools) {
        const due = collectDueSchedules(pool.crons, now)
        if (!due.length) continue
        dispatch(s => {
          // one-time schedules (at) disarm after firing
          // Record each due schedule and disarm one-time entries after their fire.
          const mark = (crons: typeof s.crons) => crons.map(c => due.some(x => x.id === c.id)
            ? { ...c, lastFiredMinute: minuteKey, last: `ran · ${timeLabel}`, on: c.at ? false : c.on }
            : c)
          if (pool.wid === s.activeWorkspace) return { ...s, crons: mark(s.crons) }
          const d = s.workspaceData[pool.wid]
          if (!d) return s
          return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, crons: mark(d.crons) } } }
        })
        for (const c of due) {
          fireAddonHookRef.current('onCronFired', {
            name: c.name,
            kind: c.boardTask || c.templateId ? 'task' : c.cmd ? 'command' : 'log',
          })
          if (c.boardTask) {
            // schedule adds a task to the kanban board instead of launching;
            // it carries the full task spec, and startNow spawns its watcher-
            // driven one-shot on the next scheduler tick
            const bt = c.boardTask
            const newTask: BoardTask = {
              id: mkId('t'), title: bt.title.slice(0, 120), col: 'backlog', agentId: null,
              description: bt.description,
              criteria: bt.criteria,
              templateId: bt.templateId,
              typeId: bt.typeId,
              cwd: bt.cwd,
              scheduleAt: bt.startNow ? now.getTime() : undefined,
              chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: Date.now() }],
            }
            dispatch(s => {
              if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
              const d = s.workspaceData[pool.wid]
              if (!d) return s
              return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
            })
            logEvent('cron', null, `${c.name} fired · added board task “${bt.title.slice(0, 48)}”`)
            notify('cron', `${c.name} fired`, `added task: ${bt.title.slice(0, 60)}`, null)
            continue
          }
          const tpl = c.templateId ? (st.templates ?? []).find(t => t.id === c.templateId) : undefined
          if (tpl) {
            // template schedules always go through the kanban board: the task
            // starts immediately (next tick) and its watcher drives the run
            const newTask: BoardTask = {
              id: mkId('t'), title: (c.prompt || c.name).slice(0, 120), col: 'backlog', agentId: null,
              description: c.prompt, templateId: tpl.id, scheduleAt: now.getTime(),
              chat: [{ id: mkId('tc'), role: 'system', text: `Added by schedule “${c.name}”`, at: Date.now() }],
            }
            dispatch(s => {
              if (pool.wid === s.activeWorkspace) return { ...s, tasks: s.tasks.concat([newTask]) }
              const d = s.workspaceData[pool.wid]
              if (!d) return s
              return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: d.tasks.concat([newTask]) } } }
            })
            logEvent('cron', null, `${c.name} fired · queued board task for template “${tpl.name}”`)
            notify('cron', `${c.name} fired`, `board task queued · template ${tpl.name}`, null)
            continue
          }
          const launchedId = !native.isTauri ? null
            : c.cmd ? launchSession(c.cmd, c.cwd || '', c.name, undefined, pool.wid)
            : null
          logEvent('cron', launchedId, `${c.name} fired${c.cmd ? ` · launching ${c.cmd}` : ''}`)
          notify('cron', `${c.name} fired`, c.cmd ? `launched: ${c.cmd}` : 'schedule ran', launchedId)
        }
      }

      // scheduled tasks: spawn a session when their time arrives, in whatever
      // workspace the task lives in. Both active and background go through the
      // one canonical launch path (spawnTaskSession) — no duplicated logic.
      const taskPools: Array<{ wid: string; tasks: typeof st.tasks }> = [
        { wid: st.activeWorkspace, tasks: st.tasks },
        ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, tasks: d.tasks })),
      ]
      for (const pool of taskPools) {
        for (const t of collectDueTasks(pool.tasks, now)) {
          // spawnTaskSession clears scheduleAt on success; clear it on failure
          // (or in a browser build that can't launch) so it doesn't refire every tick
          const id = native.isTauri ? spawnTaskSession(t.id, { workspaceId: pool.wid, briefWatcher: true }) : null
          if (!id) dispatch(s => updateLocatedTask(s, t.id, x => ({ ...x, scheduleAt: undefined }), pool.wid))
          notify('cron', id ? 'Scheduled task started' : 'Scheduled task could not start', t.title.slice(0, 60), id)
        }
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [logEvent, notify, spawnTaskSession])

  // Master brain: run one LLM turn (chat → tools → chat), serializing turns
  const masterBusyRef = useRef(false)
  const masterQueued = useRef<{ note?: string } | null>(null)
  // cancellation for the single global Master turn (aborted on workspace delete)
  const masterAborts = useRef(new AbortRegistry())

  const lastEventRef = useRef<{ note: string; at: number } | null>(null)

  // Serialize Master turns, coalesce proactive events, and append the final reply.
  const runMaster = useCallback((eventNote?: string) => runMasterLoop({
    stateRef, dispatch, masterBusyRef, masterQueued, lastEventRef, toolApprovalsRef, userStoppedRef,
    addonAgentHistories, addonEditorHistories, launchSession, launchFromTemplate, armResponseWatch,
    sessionScreenTail, logEvent, flash, applyAgentStatus, setNeedsInput, makeAddonApi,
    signal: () => masterAborts.current.signal('master'),
  }, eventNote), [applyAgentStatus, armResponseWatch, flash, makeAddonApi, launchFromTemplate, launchSession, logEvent, sessionScreenTail, setNeedsInput])

  masterEventRef.current = (note, agentId) => {
    const s = stateRef.current
    const wid = widOf(s, agentId ?? null)
    if (wid === s.activeWorkspace) {
      void runMaster(note)
      return
    }
    dispatch(s2 => {
      const d = s2.workspaceData[wid]
      if (!d) return s2
      return {
        ...s2,
        workspaceData: { ...s2.workspaceData, [wid]: { ...d, pendingMasterNotes: d.pendingMasterNotes.concat([note]).slice(-10) } },
      }
    })
  }

  // dedicated customization chat per addon: private LLM history, edits apply
  // through the update_addon tool (full package replacement, validated)
  const addonEditorHistories = useRef<Map<string, ApiMessage[]>>(new Map())

  // Run the scoped addon editor and apply its validated package replacement.
  const addonRuntime = useAddonRuntime(useMemo(() => ({
    stateRef, flash, logEvent, editorHistories: addonEditorHistories,
  }), [flash, logEvent]))

  // Per-domain action slices, composed into the single action surface below.
  // The ctx objects are memoized on their (stable) callback/ref deps so each
  // slice — and therefore the ActionsCtx value — stays referentially stable
  // across state-driven provider re-renders (terminal output / chat streaming
  // must not re-render action consumers).
  const settingsActions = useSettingsActions(useMemo(() => ({
    dispatch, later, connectMcp, refreshSkillCatalog,
    mcpSessions: mcpSessionsRef, skillCatalogs: skillCatalogsRef,
  }), [later, connectMcp, refreshSkillCatalog]))
  const boardActions = useBoardActions(useMemo(() => ({
    dispatch, stateRef, dragId, later, flash, logEvent,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    spawnSessionForTask, startTaskViaWatcher, runWatcher, pushTaskChat,
    markUserStopped: (id: string) => userStoppedRef.current.add(id),
    watcherHistories, watcherQueue, abortWatcher: (tid: string) => watcherAborts.current.abort(tid), taskSessions: taskSessionsRef,
  }), [later, flash, logEvent, spawnSessionForTask, startTaskViaWatcher, runWatcher, pushTaskChat]))
  const schedulesActions = useSchedulesActions(useMemo(() => ({ dispatch, flash, logEvent, launchFromTemplate }), [flash, logEvent, launchFromTemplate]))
  const chatActions = useChatActions(useMemo(() => ({ dispatch, stateRef, logEvent, runChatMessage }), [logEvent, runChatMessage]))
  const addonsActions = useAddonsActions(useMemo(() => ({
    dispatch, stateRef, flash, installPackage: addonRuntime.installPackage,
    sendAddonChat: (id: string, text: string) => { void addonRuntime.sendAddonChat(id, text) },
    makeAddonApi, addonAgentHistories, addonEditorHistories,
    abortAgent: (aid: string) => addonAborts.current.abort(aid),
  }), [flash, addonRuntime, makeAddonApi]))
  const workspaceActions = useWorkspaceActions(useMemo(() => ({
    dispatch, stateRef, later, flash, runMaster,
    markUserStopped: (id: string) => userStoppedRef.current.add(id), disposeSessionRuntime,
    abortMaster: () => masterAborts.current.abort('master'),
  }), [later, flash, runMaster, disposeSessionRuntime]))
  const shellActions = useShellActions()
  const sessionLayoutActions = useSessionLayoutActions()
  const sessionConfigActions = useSessionConfigActions()
  const sessionPromptActions = useSessionPromptActions(useMemo(() => ({
    stateRef, flash, logEvent, armResponseWatch, clearFlagged,
  }), [flash, logEvent, armResponseWatch, clearFlagged]))
  const masterActions = useMasterActions(useMemo(() => ({
    stateRef, later, runMaster, toolApprovals: toolApprovalsRef,
  }), [later, runMaster]))
  const sessionActions = useSessionActions(useMemo(() => ({
    stateRef, flash, logEvent, markUserStopped: (id: string) => userStoppedRef.current.add(id),
    disposeSessionRuntime, launchSession, probeCliSession, armResponseWatch, appendTail, clearNeeds, bumpSettle,
  }), [flash, logEvent, disposeSessionRuntime, launchSession, probeCliSession, armResponseWatch, appendTail, clearNeeds, bumpSettle]))

  // Expose stable UI actions while implementations read fresh state through stateRef.
  const actions = useMemo<ConductorActions>(() => ({
    ...settingsActions,
    ...boardActions,
    ...schedulesActions,
    ...chatActions,
    ...addonsActions,
    ...workspaceActions,
    ...shellActions,
    ...sessionLayoutActions,
    ...sessionConfigActions,
    ...sessionPromptActions,
    ...sessionActions,
    ...masterActions,
  }), [settingsActions, boardActions, schedulesActions, chatActions, addonsActions, workspaceActions, shellActions, sessionLayoutActions, sessionConfigActions, sessionPromptActions, sessionActions, masterActions])

  // surface background failures that would otherwise vanish (the webview
  // console reaches the dev log / devtools — the app shows no crash UI)
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => console.error('[yaam] unhandled rejection:', e.reason)
    const onError = (e: ErrorEvent) => console.error('[yaam] uncaught error:', e.message, e.error)
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError)
    }
  }, [])

  // ⌘K / Ctrl+K toggles the command palette; Escape closes overlays
  useEffect(() => {
    // Open global UI shortcuts unless an editable control owns the keystroke.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        dispatch(s => ({ ...s, paletteOpen: !s.paletteOpen, paletteQuery: '' }))
      } else if (e.key === 'Escape') {
        dispatch(s => ({ ...s, paletteOpen: false, notifOpen: false, drawer: null, newSessionOpen: false }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
}

export { useConductor, useConductorSelector, useActions, shallowEqual } from './store/hooks'

export type { LogLine }
