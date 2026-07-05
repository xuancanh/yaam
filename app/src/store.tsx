/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  Addon, AddonHookName, AgentTemplate, AppState, BoardTask, EscOption, EventType, LogLine,
  ChatMsg, NotifKind, PersistedState, TaskChatMsg,
} from './core/types'
import * as native from './core/native'
import { buildCfg, hasCreds } from './master'
import type { ApiMessage } from './master'
import { disposeTerminal, getTerminal, isAltScreen, readScreen, repaintSession } from './core/terminals'
import { DANGEROUS_PERMISSIONS, enforcePermissions, execAddonHook, exportAddonPackage, parseAddonPackage } from './core/addons'
import { runAddonEditorTurn } from './domains/addons/addon-editor'
import { runAddonAgentTurn } from './domains/addons/addon-agent'
import { fetchSkillRegistry } from './core/skills'
import type { CatalogSkill } from './core/skills'
import { mcpConnect } from './core/mcp'
import type { McpSession } from './core/mcp'
import { estimateLogUsage, estimateOutputUsage } from './core/usage'
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
import { createAddonApi } from './domains/addons/addon-api'
import { applyResolvedSecrets, secretEntries } from './store/secrets'
import { AbortRegistry, isAbortError } from './core/abort-registry'
import { buildLaunch } from './domains/session/launch'
import { classifyExit } from './domains/session/exit'
import { useSessionSettle } from './domains/session/use-settle'
import { buildHydration } from './infrastructure/persistence/hydrate'
import { loadSnapshot } from './infrastructure/persistence/loaders'
import { inferLegacyTerminalShell } from './store/state-helpers'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from './domains/board/task-state'
import type { LocatedTask } from './domains/board/task-state'
import type { ConductorActions } from './app/actions'



import { mkId } from './shared/id'
import { chatTranscriptsChanged } from './infrastructure/persistence/subscribe'
import { createPersistenceRuntime } from './infrastructure/persistence/runtime'
import type { PersistenceRuntime } from './infrastructure/persistence/runtime'
import { collectDueSchedules, collectDueTasks } from './domains/schedules/due'
import { buildTemplateCommand } from './domains/schedules/template-command'
import { focusSessionIn, removeFromGroups } from './domains/session/layout-state'
import { envPrefix, sendLineToSession, spawnAgentProcess, typeForCommand } from './domains/session/command'
import { taskContract, taskWorkText } from './domains/board/task-prompt'

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
  // Resolve the workspace that should own an event associated with a session.
  const widOf = useCallback((s: AppState, agentId: string | null): string => {
    if (!agentId) return s.activeWorkspace
    const agent = s.agents.find(a => a.id === agentId)
    return agent?.workspaceId && (s.workspaces.some(w => w.id === agent.workspaceId))
      ? agent.workspaceId
      : s.activeWorkspace
  }, [])

  // Append an activity item to the owning active or background workspace.
  const logEvent = useCallback((type: EventType, agentId: string | null, text: string) => {
    const item = { id: mkId('e'), type, agentId, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    dispatch(s => {
      const wid = widOf(s, agentId)
      if (wid === s.activeWorkspace) return { ...s, events: [item].concat(s.events).slice(0, 200) }
      const d = s.workspaceData[wid]
      if (!d) return s
      return { ...s, workspaceData: { ...s.workspaceData, [wid]: { ...d, events: [item].concat(d.events).slice(0, 200) } } }
    })
  }, [widOf])

  // Add a notification to the correct workspace and request native attention.
  const notify = useCallback((kind: NotifKind, title: string, detail: string, agentId: string | null) => {
    const item = {
      id: mkId('n'), kind, title, detail,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false, agentId,
    }
    dispatch(s => {
      const wid = widOf(s, agentId)
      if (wid === s.activeWorkspace) return { ...s, notifications: [item].concat(s.notifications).slice(0, 30) }
      const d = s.workspaceData[wid]
      if (!d) return s
      return { ...s, workspaceData: { ...s.workspaceData, [wid]: { ...d, notifications: [item].concat(d.notifications).slice(0, 30) } } }
    })
  }, [widOf])

  // Agents → Master / user leg. We never react to individual lines: each
  // session has a settle watcher, and only once output has been quiet for a
  // few seconds do we look at the tail. If the LLM Master is enabled, IT
  // decides whether the session is waiting on the user (flag_needs_input);
  // without it, a prompt-shaped final line is required.
  // Prefer the rendered screen for TUI context and fall back to retained log lines.
  const sessionScreenTail = useCallback((id: string): string => {
    const lines = isAltScreen(id)
      ? readScreen(id)
      : (stateRef.current.agents.find(a => a.id === id)?.log ?? []).map(l => l.x)
    return lines.filter(Boolean).slice(-10).join('\n') || '(no output)'
  }, [])

  // Record a settled prompt, deduplicate it, and surface user-action state.
  const setNeedsInput = useCallback((id: string, question: string, options?: EscOption[], cursorNum?: number) => {
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || agent.status !== 'running') return
    dispatch(s => {
      const msg = {
        id: mkId('m'), role: 'master' as const, kind: 'escalate' as const, escFor: id,
        esc: {
          name: agent.name, color: agent.color, repo: agent.repo, reason: question,
          resolved: false, decision: null,
          options: options?.length ? options : undefined,
          cursorNum: cursorNum ?? 1,
        },
      }
      const withStatus = {
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'needs' as const, escReason: question, attention: true } : a),
      }
      const wid = widOf(s, id)
      if (wid === s.activeWorkspace) return { ...withStatus, messages: s.messages.concat([msg]) }
      const d = s.workspaceData[wid]
      if (!d) return withStatus
      return { ...withStatus, workspaceData: { ...s.workspaceData, [wid]: { ...d, messages: d.messages.concat([msg]) } } }
    })
    logEvent('escalate', id, `${agent.name} is asking for input: ${question.slice(0, 64)}`)
    notify('escalate', `${agent.name} needs your input`, question.slice(0, 80), id)
    fireAddonHookRef.current('onNeedsInput', { sessionId: id, name: agent.name, question })
  }, [logEvent, notify, widOf])

  // ref: setNeedsInput is declared before the hook runner
  const fireAddonHookRef = useRef<(hook: AddonHookName, event: Record<string, unknown>) => void>(() => {})
  const runAddonAgentRef = useRef<(addonId: string, note: string) => Promise<string>>(async () => 'agent not ready')
  /** sessions the user stopped via ■ — their exit is a STOP, not a completion/failure */
  const userStoppedRef = useRef<Set<string>>(new Set())
  /** one-shot user approvals for Ask-first Master tools (consumed on use) */
  const toolApprovalsRef = useRef<Set<string>>(new Set())

  // shared by Master's update_agent_status tool and the per-session monitors
  // Merge monitor-authored status fields into one session card.
  const applyAgentStatus = useCallback((sid: string, task?: string, summary?: string, actionNeeded?: string) => {
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    dispatch(s2 => ({
      ...s2,
      agents: s2.agents.map(a => a.id === sid
        ? {
            ...a,
            task: task !== undefined ? (task || undefined) : a.task,
            summary: summary !== undefined ? (summary || undefined) : a.summary,
            actionNeeded: actionNeeded !== undefined ? (actionNeeded || undefined) : a.actionNeeded,
            attention: a.attention || Boolean(actionNeeded),
            summaryAt: at,
          }
        : a),
    }))
  }, [])

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

  // ANSI-stripped tail of each terminal, kept for Master's context, overview
  // cards, and rough output-volume accounting (provider usage is unavailable).
  // Retain bounded plain-text output and update character-based usage estimates.
  const appendTail = useCallback((id: string, line: string) => {
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => {
        if (a.id !== id) return a
        // Old releases added a fixed 10 tokens for every line. Rebase those
        // counters on the retained output tail before using the character estimate.
        const base = a.usageVersion === 1 ? a : estimateLogUsage(a.log)
        const delta = estimateOutputUsage(line)
        const log = a.log.concat([{ t: 'out' as const, x: line }])
        if (log.length > 200) log.splice(0, log.length - 200)
        return {
          ...a,
          log,
          used: base.used + delta.used,
          cost: base.cost + delta.cost,
          usageVersion: 1,
        }
      }),
    }))
  }, [])

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

  useEffect(() => {
    const offExit = native.onSessionExit(e => {
      const agent = stateRef.current.agents.find(a => a.id === e.id)
      const userStopped = userStoppedRef.current.delete(e.id)
      const taskFor = taskForSession(e.id)
      const cls = classifyExit({
        code: e.code, userStopped, ephemeral: !!agent?.ephemeral,
        autoArchive: !!agent?.autoArchive, hasTask: !!taskFor,
      })
      const { failed } = cls
      dispatch(s => {
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
          native.detectCliSession(probeType.probe, agent.cwd || undefined, agent.launchedAt).then(sid => {
            if (!sid) return
            dispatch(s2 => ({
              ...s2,
              agents: s2.agents.map(a => a.id === e.id ? { ...a, cliSessionId: sid } : a),
            }))
          }).catch(() => {})
        }
      }
      if (agent) {
        fireAddonHookRef.current('onSessionExit', { sessionId: e.id, name: agent.name, code: e.code })
        // if this session was working a kanban task, its watcher assesses the outcome
        if (taskFor) {
          const tail = (agent.log ?? []).slice(-12).map(l => l.x).join('\n')
          pushTaskChat(taskFor.task.id, 'system', userStopped
            ? 'Session stopped by the user'
            : failed
              ? `One-shot session exited with code ${e.code}`
              : 'One-shot session exited cleanly')
          runWatcherRef.current(taskFor.task.id, userStopped
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
            void monitorEventRef.current(e.id, failed
              ? `This one-shot (ephemeral) agent exited with code ${e.code} before completing. Summarize what went wrong from the output and report to Master.`
              : 'This one-shot (ephemeral) agent finished its task and exited cleanly, as designed. Summarize what it did from the final output and report a digest to Master.')
          }
          if (cls.autoArchive) {
            // give the monitor a moment to read the final screen, then tidy up
            window.setTimeout(() => dispatch(s => ({
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
            void monitorEventRef.current(e.id,
              `The session process ${failed ? `exited with code ${e.code}` : 'finished and exited cleanly'}. Update the status and report a digest to Master.`)
          }
        }
      }
    })
    return () => { offExit() }
  }, [logEvent, notify, pushTaskChat, taskForSession])


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

  // Capture the CLI's own session id (claude/codex) by watching for the
  // session file it creates. Interactive claude ignores --session-id for
  // local persistence, so file detection is the reliable mechanism; after a
  // resume we re-probe because --fork-session (and older CLIs) mint a new id.
  // Poll native session files until the launched CLI's resume id is discoverable.
  const probeCliSession = useCallback((id: string, command: string, cwd: string, isResume: boolean) => {
    const probeType = typeForCommand(command, stateRef.current.agentTypes)
      ?? typeForCommand(stateRef.current.agents.find(a => a.id === id)?.cmd ?? '', stateRef.current.agentTypes)
    if (!probeType?.probe || !native.isTauri) return
    if (!isResume && /--resume|resume |--continue/.test(command)) return
    const spawnedAt = Date.now()
    // Probe repeatedly because CLIs create their resume files after process start.
    const tryDetect = () => {
      const current = stateRef.current.agents.find(a => a.id === id)
      if (!current) return
      if (!isResume && current.cliSessionId) return
      // ids already claimed by other live sessions — so concurrent sessions
      // (codex/opencode stores aren't cwd-scoped) can't resolve to the same file
      const exclude = stateRef.current.agents
        .filter(a => a.id !== id && a.cliSessionId)
        .map(a => a.cliSessionId!)
      native.detectCliSession(probeType.probe!, cwd || undefined, spawnedAt, exclude).then(sid => {
        if (!sid || sid === stateRef.current.agents.find(a => a.id === id)?.cliSessionId) return
        dispatch(s2 => ({
          ...s2,
          agents: s2.agents.map(a => a.id === id
            ? { ...a, cliSessionId: sid, log: a.log.concat([{ t: 'sys', x: `${isResume ? 'session id changed on resume' : `captured ${probeType.name} session`} · ${sid}` }]) }
            : a),
        }))
      }).catch(() => {})
    }
    later(7000, tryDetect)
    later(25000, tryDetect)
    if (!isResume) later(60000, tryDetect)
  }, [later])

  // Create optimistic session state, spawn its PTY, and attach lifecycle tracking.
  const launchSession = useCallback((command: string, cwd: string, nameHint?: string, typeId?: string, workspaceId?: string, opts?: { ephemeral?: boolean; autoArchive?: boolean; templateId?: string; terminalShell?: string }): string | null => {
    const plan = buildLaunch({ command, cwd, nameHint, typeId, workspaceId, opts }, stateRef.current.agentTypes, stateRef.current.activeWorkspace)
    if (!plan) return null
    const { agent, spawnCommand, knownSessionId, launchType } = plan
    const id = agent.id
    dispatch(s => {
      const withAgent = { ...s, agents: s.agents.concat([agent]) }
      // background-workspace launches (cron) must not touch the active layout
      if (agent.workspaceId !== s.activeWorkspace) return withAgent
      return { ...focusSessionIn(withAgent, id), newSessionOpen: false }
    })
    getTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id), () => armResponseWatch(id))
    // Claude's id is known up front; only codex/opencode need file detection.
    if (!knownSessionId) probeCliSession(id, agent.cmd ?? '', agent.cwd ?? '', false)
    native.spawnSession(id, `${envPrefix(launchType?.env)}${spawnCommand}`, agent.cwd || undefined, undefined, undefined, opts?.terminalShell).catch(err => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err', x: String(err) }]) }
          : a),
      }))
    })
    return id
  }, [appendTail, armResponseWatch, bumpSettle, clearNeeds, probeCliSession])

  // Launch a session from an agent template: the template decides the CLI,
  // one-shot vs interactive mode, prompt/system prompt, approval, and model.
  // Resolve a persisted template into a command and launch it in the target workspace.
  const launchFromTemplate = useCallback((templateId: string, task?: string, workspaceId?: string, cwdOverride?: string, forceEphemeral?: boolean, contract?: string): string | null => {
    const st = stateRef.current
    const stored = (st.templates ?? []).find(t => t.id === templateId)
    if (!stored) {
      flash('Template not found')
      return null
    }
    const tpl = forceEphemeral && stored.mode !== 'ephemeral' ? { ...stored, mode: 'ephemeral' as const } : stored
    const type = st.agentTypes.find(t => t.id === tpl.typeId)
    const command = buildTemplateCommand(tpl, type, task, contract)
    const id = launchSession(command, cwdOverride || tpl.cwd || st.settings.defaultCwd || '', tpl.name, type?.id, workspaceId, {
      ephemeral: tpl.mode === 'ephemeral', autoArchive: tpl.autoArchive, templateId: tpl.id,
    })
    if (id) logEvent('route', id, `Launched template “${tpl.name}”${task ? ` · ${task.slice(0, 48)}` : ''}`)
    return id
  }, [flash, launchSession, logEvent])

  // Board → session: an unassigned task dragged into work (or explicitly
  // started) spawns its template — or the default agent type — with the task
  // as its prompt.
  // Launch a one-shot worker for a board task and bind its dedicated watcher.
  // Core one-shot launch for a board task. The watcher owns spawning: it calls
  // this via its spawn_session tool (extraInstructions augment the prompt), and
  // a task may accumulate several sessions (task.agentIds).
  // The ONE canonical one-shot launch for a board task, in any workspace (active
  // or background). Locates the task, launches its template — or the default
  // agent type — one-shot, binds its watcher, and updates the card in its own
  // workspace slice. The scheduler, the watcher's spawn tool, and the board's
  // start/drag paths all go through here so active and background behave identically.
  const spawnTaskSession = useCallback((
    taskId: string,
    opts?: { extraInstructions?: string; briefWatcher?: boolean; workspaceId?: string },
  ): string | null => {
    const st = stateRef.current
    const located = findTaskInState(st, taskId, opts?.workspaceId)
    if (!located) return null
    const { task, workspaceId } = located
    // layered prompt: work text fills the template's {task} slot; the
    // verification contract (criteria + goal) is appended after the composed
    // prompt so template framing can't swallow or contradict it
    const work = taskWorkText(task)
      + (opts?.extraInstructions?.trim() ? `\n\nAdditional instructions from the task watcher:\n${opts.extraInstructions.trim()}` : '')
    const contract = taskContract(task)
    let id: string | null = null
    // watcher-driven task sessions are ALWAYS one-shot: they run the task and exit
    if (task.templateId && (st.templates ?? []).some(t => t.id === task.templateId)) {
      id = launchFromTemplate(task.templateId, work, workspaceId, task.cwd, true, contract)
    } else {
      const type = (task.typeId ? st.agentTypes.find(t => t.id === task.typeId) : undefined)
        ?? st.agentTypes.find(t => t.enabled)
      if (!type) {
        flash('No enabled agent type to handle the task')
        return null
      }
      const oneShot: AgentTemplate = {
        id: '', name: task.title.slice(0, 18), typeId: type.id, mode: 'ephemeral',
        prompt: '{task}', systemPrompt: '', model: '', approval: 'edits', cwd: '', extraArgs: '', autoArchive: false,
      }
      id = launchSession(buildTemplateCommand(oneShot, type, work, contract), task.cwd || st.settings.defaultCwd || '', task.title.slice(0, 18), type.id, workspaceId, { ephemeral: true })
    }
    if (!id) return null
    taskSessionsRef.current.set(id, { taskId, workspaceId })
    const sessionName = stateRef.current.agents.find(a => a.id === id)?.name ?? id
    dispatch(s2 => updateLocatedTask(s2, taskId, t => ({
      ...t, agentId: id, agentIds: [...(t.agentIds ?? []), id!], scheduleAt: undefined,
      col: t.col === 'backlog' || t.col === 'done' || t.col === 'failed' ? 'progress' as const : t.col,
    }), workspaceId))
    armResponseWatch(id)
    pushTaskChat(taskId, 'system', `Spawned one-shot session “${sessionName}” for this task`)
    if (!task.cwd && !st.settings.defaultCwd && !(task.templateId && (st.templates ?? []).find(t => t.id === task.templateId)?.cwd)) {
      pushTaskChat(taskId, 'system',
        '⚠ No working folder set — the session runs in your home directory. If this task targets a repo, set the folder in the task spec and Relaunch.')
    }
    if (opts?.briefWatcher) {
      runWatcherRef.current(taskId,
        `A one-shot session "${sessionName}" was just spawned to work this task; it received the title, description and criteria as its prompt, with the criteria set as an explicit goal (stop condition) it must self-verify before exiting. ` +
        'Set your card note, make sure the task sits in the right column, and post one short kickoff message for the user.')
    }
    logEvent('route', id, `Spawned session for task “${task.title.slice(0, 48)}”`)
    flash(`Session spawned for “${task.title.slice(0, 28)}”`)
    return id
  }, [armResponseWatch, flash, launchFromTemplate, launchSession, logEvent, pushTaskChat])

  spawnTaskSessionRef.current = (taskId, extraInstructions) => spawnTaskSession(taskId, { extraInstructions })

  // Deterministic start (drag to progress, schedules, no-brain fallback):
  // spawn directly, then brief the watcher. Optionally targets a background
  // workspace (the scheduler fires tasks in every workspace).
  const spawnSessionForTask = useCallback((taskId: string, workspaceId?: string) => {
    const located = findTaskInState(stateRef.current, taskId, workspaceId)
    if (!located || located.task.agentId) return
    spawnTaskSession(taskId, { briefWatcher: true, workspaceId: located.workspaceId })
  }, [spawnTaskSession])

  // Watcher-first start (the mini master owns spawning): hand the task to its
  // watcher, which calls spawn_session; fall back to a direct spawn when there
  // is no brain or the watcher fails to act.
  const startTaskViaWatcher = useCallback((taskId: string) => {
    const st = stateRef.current
    const task = st.tasks.find(t => t.id === taskId)
    if (!task || task.agentId) return
    if (!(st.settings.masterEnabled && hasCreds(st.settings))) {
      spawnSessionForTask(taskId)
      return
    }
    pushTaskChat(taskId, 'system', 'Start requested — handing to the watcher')
    void runWatcher(taskId,
      'The user started this task. You own spawning: call spawn_session now (add extra_instructions only if the spec needs augmenting), set your card note, and post one short kickoff message. If spawning fails, tell the user why.',
    ).then(() => {
      const after = stateRef.current.tasks.find(t => t.id === taskId)
      if (after && !after.agentId && !(after.agentIds ?? []).length) {
        pushTaskChat(taskId, 'system', 'Watcher did not spawn a session — starting one directly')
        spawnSessionForTask(taskId)
      }
    })
  }, [pushTaskChat, runWatcher, spawnSessionForTask])

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
  const mcpSessionsRef = useRef<Map<string, McpSession>>(new Map())

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
  const updateChatLog = useCallback((agentId: string, msgId: string, text: string) => {
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === agentId
        ? { ...a, chatLog: (a.chatLog ?? []).map(m => (m.id === msgId ? { ...m, text } : m)) }
        : a),
    }))
  }, [])

  // Append one visible message to a chat session's persisted transcript.
  const pushChatLog = useCallback((id: string, msg: Omit<ChatMsg, 'id' | 'at'>) => {
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, chatLog: [...(a.chatLog ?? []), { id: mkId('cm'), at: Date.now(), ...msg }].slice(-200) }
        : a),
    }))
  }, [])

  // (Re)connect one MCP server and cache its live session + tool inventory.
  const connectMcp = useCallback(async (id: string): Promise<string> => {
    const server = stateRef.current.mcpServers.find(x => x.id === id)
    if (!server) return 'server not found'
    try {
      const session = await mcpConnect(server.name, server.url, server.headers)
      mcpSessionsRef.current.set(id, session)
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: session.tools.length, lastError: undefined } : x),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      mcpSessionsRef.current.delete(id)
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => x.id === id ? { ...x, toolCount: undefined, lastError: msg } : x),
      }))
      return msg
    }
  }, [])

  // skill-registry catalogs (fetched lazily, cached per registry id)
  const skillCatalogsRef = useRef<Map<string, CatalogSkill[]>>(new Map())

  const refreshSkillCatalog = useCallback(async (id: string): Promise<string> => {
    const reg = stateRef.current.skillRegistries.find(r => r.id === id)
    if (!reg) return 'registry not found'
    try {
      const catalog = await fetchSkillRegistry(reg.name, reg.url)
      skillCatalogsRef.current.set(id, catalog)
      dispatch(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: catalog.length, lastError: undefined } : r)),
      }))
      return ''
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      dispatch(s2 => ({
        ...s2,
        skillRegistries: s2.skillRegistries.map(r => (r.id === id ? { ...r, skillCount: undefined, lastError: msg } : r)),
      }))
      return msg
    }
  }, [])

  // keep the embedded search index in sync with chat transcripts (debounced).
  // Subscribes to the store but only re-arms when a chat transcript actually
  // changes — unrelated PTY output no longer schedules a full reindex.
  const reindexTimer = useRef<number | undefined>(undefined)
  const armReindex = useCallback(() => {
    if (reindexTimer.current) window.clearTimeout(reindexTimer.current)
    reindexTimer.current = window.setTimeout(() => {
      const docs = stateRef.current.agents
        .filter(a => a.kind === 'chat')
        .flatMap(a => (a.chatLog ?? [])
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ chatId: a.id, msgId: m.id, role: m.role, text: `${a.name}\n${m.text}` })))
      void native.chatSearchReindex(docs).catch(() => {})
    }, 1500)
  }, [])
  useEffect(() => useAppStore.subscribe((s, prev) => {
    if (chatTranscriptsChanged(s, prev)) armReindex()
  }), [armReindex])

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
  const sendAddonChatImpl = useCallback(async (id: string, text: string) => {
    const st = stateRef.current.settings
    const addon = stateRef.current.addons.find(a => a.id === id)
    if (!addon) return
    dispatch(s2 => ({
      ...s2,
      addonChats: { ...s2.addonChats, [id]: (s2.addonChats[id] ?? []).concat([{ role: 'you', text }]) },
      addonChatBusy: id,
    }))
    // Append an editor reply to the addon's bounded customization history.
    const reply = (t: string) => dispatch(s2 => ({
      ...s2,
      addonChats: { ...s2.addonChats, [id]: (s2.addonChats[id] ?? []).concat([{ role: 'master', text: t }]) },
      addonChatBusy: s2.addonChatBusy === id ? null : s2.addonChatBusy,
    }))
    if (!(hasCreds(st) && st.masterEnabled)) {
      reply('The addon editor needs the LLM Master configured (Settings → Master Brain).')
      return
    }
    let history = addonEditorHistories.current.get(id)
    if (!history) {
      history = []
      addonEditorHistories.current.set(id, history)
    }
    // Validate and atomically replace the addon's editable package fields.
    const apply = (json: string): string => {
      try {
        const parsed = parseAddonPackage(json)
        dispatch(s2 => ({
          ...s2,
          addons: s2.addons.map(a => a.id === id
            ? { ...a, ...parsed, id, source: a.source, enabled: a.enabled, granted: a.granted.filter(g => parsed.permissions.includes(g)), createdAt: new Date().toLocaleString() }
            : a),
        }))
        logEvent('build', null, `Addon “${parsed.name}” updated via its chat (v${parsed.version})`)
        return `applied — the addon is now v${parsed.version}`
      } catch (e) {
        return `rejected: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    try {
      const current = stateRef.current.addons.find(a => a.id === id)
      const out = await runAddonEditorTurn(
        buildCfg(st), current ? exportAddonPackage(current) : '{}', history, text, apply)
      reply(out || '(updated)')
    } catch (e) {
      reply(`Editor error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [logEvent])

  // Validate and install or replace an addon package while preserving grants.
  const installPackage = useCallback((json: string, source: Addon['source']) => {
    const parsed = parseAddonPackage(json) // throws readable errors
    const existing = stateRef.current.addons.find(a => a.name === parsed.name)
    const addon: Addon = {
      ...parsed,
      id: existing?.id ?? mkId('ad'),
      // upgrades keep the user's grant choices (intersected with what's now
      // requested); fresh installs never auto-grant dangerous scopes — the
      // user enables them per-addon in Settings -> Addons
      granted: existing
        ? existing.granted.filter(g => parsed.permissions.includes(g))
        : parsed.permissions.filter(g => !DANGEROUS_PERMISSIONS.includes(g)),
      enabled: true,
      source,
      createdAt: new Date().toLocaleString(),
    }
    dispatch(s2 => ({
      ...s2,
      addons: existing ? s2.addons.map(a => (a.id === existing.id ? addon : a)) : s2.addons.concat([addon]),
      ...(addon.html ? { view: 'addon' as const, activeAddon: addon.id } : {}),
    }))
    logEvent('build', null, `Installed addon “${addon.name}” v${addon.version} (${source})`)
    const withheld = addon.permissions.filter(g => !addon.granted.includes(g))
    flash(withheld.length
      ? `Installed ${addon.name} · grant ${withheld.join(', ')} in Settings → Addons to enable those features`
      : `Installed ${addon.name} v${addon.version}`)
  }, [flash, logEvent])

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
    dispatch, stateRef, flash, installPackage,
    sendAddonChat: (id: string, text: string) => { void sendAddonChatImpl(id, text) },
    makeAddonApi, addonAgentHistories, addonEditorHistories,
    abortAgent: (aid: string) => addonAborts.current.abort(aid),
  }), [flash, installPackage, sendAddonChatImpl, makeAddonApi]))
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
    ...masterActions,

    archiveSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.status === 'running' || agent?.status === 'needs') {
        userStoppedRef.current.add(id)
        native.killSession(id).catch(() => {})
      }
      // free the xterm buffer + runtime registries; the agent (with its log
      // tail) stays persisted and the terminal is rebuilt on unarchive
      disposeSessionRuntime(id)
      dispatch(s => ({
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.map(a => a.id === id ? { ...a, archived: true, status: 'idle' as const, escReason: undefined } : a),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
      }))
      flash(`Archived ${agent?.name ?? 'session'}`)
      logEvent('edit', id, `Archived session ${agent?.name ?? id}`)
    },

    unarchiveSession: id => {
      // the xterm was disposed on archive — recreate it and replay the retained
      // (dimmed) tail, mirroring how restore rebuilds a paused session
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent && agent.kind !== 'chat') {
        disposeTerminal(id)
        const { term } = getTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id), () => armResponseWatch(id))
        for (const l of agent.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
        term.writeln('\x1b[33m── unarchived · press ▶ to relaunch ──\x1b[0m')
      }
      dispatch(s => focusSessionIn(s, id))
    },

    deleteSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      userStoppedRef.current.add(id)
      native.killSession(id).catch(() => {})
      disposeSessionRuntime(id)
      native.removeSession(id).catch(() => {}) // drop its persisted file too
      dispatch(s => ({
        ...s,
        ...removeFromGroups(s, id),
        agents: s.agents.filter(a => a.id !== id),
        tasks: s.tasks.map(t => (t.agentId === id || t.agentIds?.includes(id)
          ? { ...t, agentId: t.agentId === id ? null : t.agentId, agentIds: (t.agentIds ?? []).filter(x => x !== id) }
          : t)),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        drawer: s.drawer?.agentId === id ? null : s.drawer,
        panel: s.panel?.agentId === id ? null : s.panel,
      }))
      flash(`Deleted ${agent?.name ?? 'session'}`)
      logEvent('edit', null, `Deleted session ${agent?.name ?? id}`)
    },

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.kind === 'chat') return // chat agents have no process; just send a message
      const terminalShell = agent?.terminalShell ?? inferLegacyTerminalShell(agent?.cmd)
      let resumeNote = 'session resumed'
      if (agent?.kind === 'real' && agent.cmd && agent.status !== 'running') {
        // prefer the CLI's own resume flow so the conversation continues
        let cmd = agent.cmd
        const type = stateRef.current.agentTypes.find(t => t.id === agent.typeId)
          ?? typeForCommand(agent.cmd, stateRef.current.agentTypes)
        if (type?.resumeCmd) {
          if (type.resumeCmd.includes('{id}')) {
            if (agent.cliSessionId) {
              cmd = type.resumeCmd.replace('{id}', agent.cliSessionId)
              resumeNote = `resuming ${type.name} session ${agent.cliSessionId}`
            } else if (type.resumeFallbackCmd) {
              cmd = type.resumeFallbackCmd
              resumeNote = `no captured session id — resuming most recent via · ${cmd}`
            }
          } else {
            cmd = type.resumeCmd
            resumeNote = `resuming via · ${cmd}`
          }
        }
        spawnAgentProcess(id, `${envPrefix(type?.env)}${cmd}`, agent.cwd, terminalShell).catch(() => {})
        probeCliSession(id, cmd, agent.cwd || '', true)
      }
      dispatch(s => focusSessionIn({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, terminalShell, status: 'running' as const, log: a.log.concat([{ t: 'sys', x: resumeNote }]) }
          : a),
      }, id))
    },



    newRealSession: (command, cwd, terminalShell) => {
      const id = launchSession(command, cwd, undefined, undefined, undefined, { terminalShell })
      if (id) {
        logEvent('route', id, `Launched session · ${command.trim()}`)
        flash('Session launched')
      }
    },

    sendInput: (id, text) => {
      armResponseWatch(id)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, log: a.log.concat([{ t: 'you', x: text }]) }
          : a),
      }))
      sendLineToSession(id, text)
    },

    stopSession: id => {
      userStoppedRef.current.add(id)
      native.killSession(id).catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'idle' as const, log: a.log.concat([{ t: 'sys', x: 'stopped by you' }]) }
          : a),
      }))
      flash('Session stopped')
    },
  }), [settingsActions, boardActions, schedulesActions, chatActions, addonsActions, workspaceActions, shellActions, sessionLayoutActions, sessionConfigActions, sessionPromptActions, masterActions, appendTail, armResponseWatch, bumpSettle, clearNeeds, disposeSessionRuntime, flash, launchSession, logEvent, probeCliSession])

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
