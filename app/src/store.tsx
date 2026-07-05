/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  Addon, AddonHookName, AddonPermission, Agent, AgentTemplate, AppState, BoardCol, BoardTask, Cron, EscOption, EventType, LogLine,
  ChatAgentType, ChatMsg, McpServer, NotifKind, Notification, Panel, Persona, PersistedState, Skill, SkillRegistry, TaskChatMsg, View,
} from './core/types'
import { defaultDetail, MASTER_GREETING, mkMemory, mkTools, PERM_ORDER, seedState } from './core/data'
import * as native from './core/native'
import { buildCfg, hasCreds } from './master'
import type { ApiMessage } from './master'
import { draftTaskSpec } from './domains/board/watcher'
import type { TaskSpecDraft } from './domains/board/watcher'
import { disposeTerminal, getTerminal, isAltScreen, readScreen, repaintSession } from './core/terminals'
import { ALL_PERMISSIONS, DANGEROUS_PERMISSIONS, dispatchAddonRpc, enforcePermissions, execAddonHook, exportAddonPackage, loadAddonFolder, parseAddonPackage } from './core/addons'
import { runAddonEditorTurn } from './domains/addons/addon-editor'
import { runAddonAgentTurn } from './domains/addons/addon-agent'
import { generateAddonPackage } from './domains/addons/addon-gen'
import { fetchSkillRegistry } from './core/skills'
import type { CatalogSkill } from './core/skills'
import { mcpConnect } from './core/mcp'
import type { McpSession } from './core/mcp'
import { estimateLogUsage, estimateOutputUsage } from './core/usage'
import type { AddonApi } from './core/addons'
import { ActionsCtx, StateCtx, StoreCtx } from './core/context'
import type { ConductorStore } from './core/context'
import { runMonitorLoop } from './domains/master/monitor-runner'
import { runWatcherLoop } from './domains/board/watcher-runner'
import { runChatMessageTurn } from './domains/chat/runner'
import { runMasterLoop } from './domains/master/runner'
import { createAddonApi } from './domains/addons/addon-api'
import { applyResolvedSecrets, redactSecrets, secretEntries } from './store/secrets'
import { reducer, withActiveGroup, inferLegacyTerminalShell } from './store/state-helpers'
import { findTaskInState, findTaskForAgentInState, updateLocatedTask } from './domains/board/task-state'
import type { LocatedTask } from './domains/board/task-state'

export interface ConductorActions {
  setView: (v: View) => void
  setComposer: (v: string) => void
  send: () => void
  focusComposer: () => void
  setActivePane: (i: number) => void
  focusTab: (id: string) => void
  setPaneLayout: (n: number, stacked?: boolean) => void
  assignPane: (i: number, id: string) => void
  closePane: (i: number) => void
  toggleMaximize: (i: number) => void
  minimizePane: (i: number) => void
  restoreSession: (id: string) => void
  setRowSplit: (v: number) => void
  setColSplit: (row: number, v: number) => void
  /** display an existing tab group in the workspace grid */
  activateGroup: (id: string) => void
  /** dissolve a tab group; its sessions return to loose tabs */
  closeGroup: (id: string) => void
  renameSession: (id: string, name: string) => void
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  startTask: (taskId: string) => void
  /** detach a dead session from a task and spawn a fresh one-shot for it */
  restartTask: (taskId: string) => void
  resume: (id: string) => void
  openPanel: (id: string, tab?: Panel['tab']) => void
  setPanelTab: (tab: Panel['tab']) => void
  closePanel: () => void
  toggleMem: (aid: string, mid: string) => void
  toggleTool: (aid: string, tid: string) => void
  cyclePerm: (aid: string, tid: string) => void
  toggleCron: (id: string) => void
  cycleCatalogPerm: (id: string) => void
  approve: (aid: string) => void
  answerPrompt: (aid: string, num: number) => void
  deny: (aid: string) => void
  gotoNeeds: () => void
  openPalette: () => void
  closePalette: () => void
  setPaletteQuery: (q: string) => void
  toggleNotif: () => void
  readAllNotif: () => void
  clickNotif: (n: Notification) => void
  openAgent: (id: string) => void
  openDiff: (id: string) => void
  closeDrawer: () => void
  approveDiff: (id: string) => void
  requestChanges: (id: string) => void
  /** MCP servers (chat agents call their tools) */
  addMcpServer: (name: string, url: string, headers?: string) => void
  updateMcpServer: (id: string, patch: Partial<Pick<McpServer, 'name' | 'url' | 'headers' | 'enabled'>>) => void
  removeMcpServer: (id: string) => void
  /** (re)connect and cache the server's tool list; resolves to error or '' */
  connectMcpServer: (id: string) => Promise<string>
  /** skills registry (local) */
  addSkill: () => string
  updateSkill: (id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'body'>>) => void
  removeSkill: (id: string) => void
  /** personas (picked per chat) */
  addPersona: () => string
  updatePersona: (id: string, patch: Partial<Pick<Persona, 'name' | 'description' | 'body'>>) => void
  removePersona: (id: string) => void
  /** skill registries (github tree URLs or local folders of SKILL.md dirs) */
  addSkillRegistry: (name: string, url: string) => void
  updateSkillRegistry: (id: string, patch: Partial<Pick<SkillRegistry, 'name' | 'url' | 'enabled'>>) => void
  removeSkillRegistry: (id: string) => void
  /** (re)fetch a registry's catalog; resolves to '' or an error message */
  refreshSkillRegistry: (id: string) => Promise<string>
  /** chat-agent types (provider + model + credentials presets) */
  addChatAgentType: () => void
  updateChatAgentType: (id: string, patch: Partial<Omit<ChatAgentType, 'id'>>) => void
  deleteChatAgentType: (id: string) => void
  /** chat-mode sessions */
  newChatSession: (name?: string, cwd?: string, chatTypeId?: string, model?: string, personaId?: string, skillSourceIds?: string[]) => string
  /** open a chat in the Chat view */
  openChat: (id: string | null) => void
  sendChatMessage: (agentId: string, text: string) => void
  toggleAgentType: (id: string) => void
  toggleSetting: (k: 'autoRoute' | 'approveDestructive' | 'followMode') => void
  /** approve (once) or deny a Master tool blocked on the Ask-first policy */
  resolveToolApproval: (id: string, approve: boolean) => void
  updateSettings: (patch: Partial<AppState['settings']>) => void
  setAgentTypeCmd: (id: string, cmd: string) => void
  updateAgentType: (id: string, patch: Partial<AppState['agentTypes'][number]>) => void
  addAgentType: () => void
  deleteAgentType: (id: string) => void
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  createTask: (input: { title: string; description: string; criteria: string[]; templateId?: string; typeId?: string; cwd?: string }) => void
  updateTask: (id: string, patch: Partial<Pick<BoardTask, 'title' | 'description' | 'criteria' | 'templateId' | 'typeId' | 'cwd'>>) => void
  sendTaskChat: (taskId: string, text: string) => void
  /** LLM assist for task creation; null when no brain is configured */
  draftTask: (input: { title: string; description: string; criteria: string[] }) => Promise<TaskSpecDraft | null>
  renameTask: (id: string, title: string) => void
  deleteTask: (id: string) => void
  addCron: (cron: Omit<Cron, 'id' | 'on' | 'built' | 'last'>) => void
  addTemplate: () => string
  updateTemplate: (id: string, patch: Partial<AgentTemplate>) => void
  deleteTemplate: (id: string) => void
  runTemplate: (id: string, task?: string) => void
  scheduleTask: (taskId: string, at: number | null, templateId?: string | null) => void
  deleteCron: (id: string) => void
  openAddon: (id: string) => void
  removeAddon: (id: string) => void
  toggleAddon: (id: string) => void
  toggleAddonGrant: (id: string, perm: AddonPermission) => void
  installAddonFromFile: () => void
  /** install a multi-file addon folder (addon.yaml/json + referenced files) */
  installAddonFromFolder: () => void
  /** LLM-generate an addon from a description; resolves to '' or an error message */
  generateAddon: (prompt: string) => Promise<string>
  installAddonFromUrl: (url: string) => void
  exportAddon: (id: string) => void
  sendAddonChat: (id: string, text: string) => void
  addonRpc: (addonId: string, method: string, args: unknown[]) => Promise<unknown>
  updateAddonMeta: (id: string, patch: Partial<Pick<Addon, 'name' | 'version' | 'icon' | 'desc' | 'author'>>) => void
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  deleteWorkspace: (id: string) => void
  openNewSession: () => void
  closeNewSession: () => void
  newRealSession: (command: string, cwd: string, terminalShell?: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}


import {
  PROMPT_RE, QUESTION_LINE_RE, QUESTION_MARK_LINE_RE, TUI_PROMPT_RE,
  activeGroupOf, buildTemplateCommand, cronMatches, envPrefix, extractOptions, focusSessionIn, groupsFromLegacy,
  mkGroup, mkId, removeFromGroups, selectMainState, selectSession,
  sendLineToSession, spawnAgentProcess, switchWorkspaceIn, taskContract, taskWorkText, typeForCommand,
} from './core/state-lib'

export { cronMatches, humanizeCron } from './core/state-lib'

/** Own the complete app state, native/LLM effects, and action surface for the UI. */
export function ConductorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, seedState)
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // External-store bridge (finding #3): selector consumers subscribe here and
  // re-render only when their slice changes. getSnapshot reads the render-synced
  // stateRef; subscribers are notified after each committed state change.
  const subscribersRef = useRef(new Set<() => void>())
  const conductorStore = useRef<ConductorStore>({
    subscribe: cb => { subscribersRef.current.add(cb); return () => { subscribersRef.current.delete(cb) } },
    getSnapshot: () => stateRef.current,
  }).current
  useEffect(() => { for (const cb of subscribersRef.current) cb() }, [state])

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
  // armed watch: snapshot of the screen/tail at arm time — we only relay once
  // the content has actually changed AND the TUI is no longer busy
  const armedRef = useRef<Map<string, { snapshot: string; at: number }>>(new Map())
  const settleRef = useRef<Map<string, { since: number; timer: number }>>(new Map())

  // Prefer the rendered screen for TUI context and fall back to retained log lines.
  const sessionScreenTail = useCallback((id: string): string => {
    const lines = isAltScreen(id)
      ? readScreen(id)
      : (stateRef.current.agents.find(a => a.id === id)?.log ?? []).map(l => l.x)
    return lines.filter(Boolean).slice(-10).join('\n') || '(no output)'
  }, [])

  // Mark a session as awaiting fresh output so the next settle means completion.
  const armResponseWatch = useCallback((id: string) => {
    const alt = isAltScreen(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    const snapshot = alt
      ? readScreen(id).join('\n')
      : (agent?.log ?? []).slice(-14).map(l => l.x).join('\n')
    armedRef.current.set(id, { snapshot, at: Date.now() })
    // ensure a settle check runs even if the session produces no output at all
    later(4000, () => bumpSettleRef.current(id))
  }, [later])

  // set below; ref avoids a declaration cycle with onSettle
  const bumpSettleRef = useRef<(id: string) => void>(() => {})

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

  const lastFlaggedRef = useRef<Map<string, string>>(new Map())

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

  // Serialize private monitor turns per session (loop body in store/monitor-runner).
  const runMonitor = useCallback((id: string, note: string) => runMonitorLoop({
    stateRef, dispatch, histories: monitorHistories, busy: monitorBusy, queue: monitorQueue,
    applyAgentStatus, setNeedsInput, logEvent, notify,
    masterEvent: (n, a) => masterEventRef.current(n, a),
  }, id, note), [applyAgentStatus, logEvent, notify, setNeedsInput])

  monitorEventRef.current = (id, note) => runMonitor(id, note)

  // ---- per-task watcher: a mini Master owning one kanban task ----
  const watcherHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const watcherBusy = useRef<Set<string>>(new Set())
  const watcherQueue = useRef<Map<string, string[]>>(new Map())
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
    taskSessions: taskSessionsRef, applyAgentStatus, pushTaskChat, logEvent, notify,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    spawnTaskSession: (id, extra) => spawnTaskSessionRef.current(id, extra),
  }, taskId, note), [applyAgentStatus, logEvent, notify, pushTaskChat])

  runWatcherRef.current = (taskId, note) => { void runWatcher(taskId, note) }

  // Inspect a stable rendered screen for prompts, completion, monitors, and watchers.
  const onSettle = useCallback((id: string, since: number) => {
    settleRef.current.delete(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || (agent.status !== 'running' && agent.status !== 'needs')) return
    const st = stateRef.current.settings
    const llm = Boolean(st.masterEnabled && hasCreds(st) && st.followMode)
    const alt = isAltScreen(id)
    const armed = armedRef.current.get(id)

    // TUIs redraw constantly, so judge the rendered screen (stable) instead
    // of the raw output stream; plain sessions use the new stream tail.
    const streamLines = agent.log.slice(since).map(l => l.x).filter(Boolean)
    const content = alt ? readScreen(id) : streamLines.slice(-14)
    if (!content.length) return
    const lastLine = content[content.length - 1] ?? ''
    // TUIs show a busy marker while generating — the turn is NOT over, so any
    // question-looking text on screen is transient. Never flag input, and never
    // relay half-answers, while the marker is visible.
    const busy = alt && /esc to interrupt|ctrl\+c to interrupt/i.test(content.join('\n'))

    const promptDetected = !busy && (alt
      ? TUI_PROMPT_RE.test(content.join('\n'))
      : PROMPT_RE.test(content.slice(-3).join('\n')) || /[?:]\s*$/.test(lastLine.trim()))

    if (promptDetected) {
      const question = (
        content.find(l => QUESTION_LINE_RE.test(l)) ||
        content.find(l => QUESTION_MARK_LINE_RE.test(l.trim())) ||
        lastLine
      ).trim()
      const already = agent.status === 'needs' && lastFlaggedRef.current.get(id) === question
      if (!already) {
        lastFlaggedRef.current.set(id, question)
        const { options, cursorNum } = extractOptions(content)
        setNeedsInput(id, question, options, cursorNum)
        if (llm) {
          masterEventRef.current(
            `[event] session "${agent.name}" (${id}) is showing a dialog (approval or selection menu) and has been flagged as needing input:\n` +
            `${content.slice(-14).join('\n')}\n\nTell the user what it is asking — include the options if it is a menu. Approve sends Enter (selects the highlighted option), Deny sends Escape; for other choices the user should click into the terminal.`,
            id,
          )
        }
        const taskFor = taskForSession(id)
        if (taskFor) {
          runWatcherRef.current(taskFor.task.id,
            `The task's session "${agent.name}" is waiting at this prompt:\n${content.slice(-14).join('\n')}\n\n` +
            'Unblock it from the task spec when safe; otherwise ask the user one focused question and update the card note.')
        }
      }
      return
    }

    // prompt gone (or the session is generating again) — it was answered
    if (agent.status === 'needs') {
      lastFlaggedRef.current.delete(id)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'running' as const, escReason: undefined } : a),
      }))
    }

    if (armed) {
      const joined = content.join('\n')
      const expired = Date.now() - armed.at > 15 * 60 * 1000
      const unchanged = joined === armed.snapshot
      if ((busy || unchanged) && !expired) {
        settleRef.current.delete(id)
        const timer = window.setTimeout(() => onSettleRef.current(id, since), 3500)
        settleRef.current.set(id, { since, timer })
        return
      }
      armedRef.current.delete(id)
      if (!expired) {
        // deterministic indicator, independent of the LLM layer: if the user
        // isn't looking at this session, flash its tab and ring the bell
        const st2 = stateRef.current
        const g2 = activeGroupOf(st2)
        const watching = (g2 ? g2.slots[g2.activePane] : null) === id
          && (agent.workspaceId ?? st2.activeWorkspace) === st2.activeWorkspace
          && document.hasFocus()
        if (!watching) {
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(a => (a.id === id ? { ...a, attention: true } : a)),
          }))
          notify('done', `${agent.name} finished responding`, lastLine.slice(0, 90), id)
        }
        // task sessions are watched by their task's watcher (the mini master
        // assigns itself as monitor) — the generic session monitor skips them
        if (llm && !taskForSession(id)) {
          void runMonitor(id,
            `The session finished responding. ${alt ? 'Current screen' : 'New output since last check'}:\n${content.slice(-14).join('\n')}\n\n` +
            'It was given a task by Master or the user, so a completed response IS noteworthy — update the status and report a digest to Master.')
        }
      }
    }

    // Task watchers own progress independently of the global follow-mode
    // monitor. Feed every stable output snapshot to the watcher, including
    // routine progress that the session monitor deliberately does not report.
    const taskFor = taskForSession(id)
    if (taskFor) {
      runWatcherRef.current(taskFor.task.id,
        `The task's session "${agent.name}" produced stable output. ${alt ? 'Current screen' : 'New output'}:\n` +
        `${content.slice(-14).join('\n')}\n\nTrack progress against the acceptance criteria, update the card note, and move the task only if the evidence supports it.`)
    }
  }, [notify, runMonitor, setNeedsInput, taskForSession])

  const onSettleRef = useRef<(id: string, since: number) => void>(() => {})
  onSettleRef.current = onSettle

  // (re)start the settle watcher — checks only run once output goes quiet.
  // Driven by RAW pty activity, because TUI redraws often contain no newlines.
  // Reset a session's quiet-period timer whenever raw PTY activity arrives.
  const bumpSettle = useCallback((id: string) => {
    const prev = settleRef.current.get(id)
    if (prev) window.clearTimeout(prev.timer)
    const since = prev?.since ?? Math.max(0, (stateRef.current.agents.find(a => a.id === id)?.log.length ?? 1) - 1)
    const timer = window.setTimeout(() => onSettle(id, since), 3000)
    settleRef.current.set(id, { since, timer })
  }, [onSettle])
  bumpSettleRef.current = bumpSettle

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

  // Deterministic safety net for full-screen TUIs: scan the rendered screen of
  // every running alt-buffer session for approval dialogs / selection menus.
  // Settle timing doesn't matter here; dedupe prevents refiring on redraws.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const a of stateRef.current.agents) {
        if (a.kind !== 'real') continue
        if (a.status !== 'running' && a.status !== 'needs') continue
        if (!isAltScreen(a.id)) continue
        const screen = readScreen(a.id)
        if (!screen.length) continue
        const joined = screen.join('\n')
        if (TUI_PROMPT_RE.test(joined)) {
          if (a.status !== 'running') continue
          const question = (
            screen.find(l => QUESTION_LINE_RE.test(l)) ||
            screen.find(l => QUESTION_MARK_LINE_RE.test(l.trim())) ||
            screen[screen.length - 1]
          ).trim()
          if (lastFlaggedRef.current.get(a.id) === question) continue
          lastFlaggedRef.current.set(a.id, question)
          const { options, cursorNum } = extractOptions(screen)
          setNeedsInput(a.id, question, options, cursorNum)
          void monitorEventRef.current(a.id,
            `A dialog was detected on the session's screen (already flagged as needing input):\n${screen.slice(-14).join('\n')}\n\n` +
            'This needs the user — report_to_master with what it is asking, including the options if it is a menu.')
        } else if (a.status === 'needs') {
          lastFlaggedRef.current.delete(a.id)
          dispatch(s2 => ({
            ...s2,
            agents: s2.agents.map(x => x.id === a.id ? { ...x, status: 'running' as const, escReason: undefined } : x),
          }))
        }
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [setNeedsInput])

  // typing into a terminal clears its "needs action" state
  // Clear a session's prompt state after the user or Master answers it.
  // The user typed into the terminal — they are handling it themselves, so
  // dismiss everything we asked of them: needs status, the card's pending
  // action, and any open approval card in the Master chat.
  const clearNeeds = useCallback((id: string) => {
    lastFlaggedRef.current.delete(id)
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
  }, [])

  useEffect(() => {
    const offExit = native.onSessionExit(e => {
      const agent = stateRef.current.agents.find(a => a.id === e.id)
      const userStopped = userStoppedRef.current.delete(e.id)
      const failed = !userStopped && e.code !== 0 && e.code !== null
      const taskFor = taskForSession(e.id)
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
          if (!failed && agent.autoArchive) {
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
  // accounts whose secret is confirmed in the OS keychain (so the plaintext
  // file can safely redact them); populated on hydrate + by the sync effect
  const keychainReadyRef = useRef<Set<string>>(new Set())
  const hydrated = useRef(false)
  const hydrateStarted = useRef(false)
  useEffect(() => {
    if (hydrateStarted.current) return
    hydrateStarted.current = true
    // Apply one merged snapshot; throws if it is not usable so the caller can
    // fall back / start fresh.
    const hydrateFrom = (p: Partial<PersistedState>) => {
          const workspaces = p.workspaces?.length ? p.workspaces : [{ id: 'ws-default', name: 'Default' }]
          const activeWorkspace = p.activeWorkspace && workspaces.some(w => w.id === p.activeWorkspace)
            ? p.activeWorkspace
            : workspaces[0].id
          const restoredAgents: Agent[] = (p.agents ?? [])
            .filter(a => (a.kind === 'real' && a.cmd) || a.kind === 'chat')
            .map(a => {
              const log = (a.log ?? []).slice(-200)
              const usage = a.usageVersion === 1 ? { used: a.used, cost: a.cost } : estimateLogUsage(log)
              // a chat persisted while running (or with an unanswered user
              // message) died mid-reply — say so instead of a silent gap
              const lastChat = (a.chatLog ?? [])[(a.chatLog ?? []).length - 1]
              const interrupted = a.kind === 'chat'
                && (a.status === 'running' || lastChat?.role === 'user' || lastChat?.role === 'thinking')
              const chatLog = interrupted
                ? [...(a.chatLog ?? []), { id: mkId('cm'), role: 'assistant' as const, text: '*(interrupted — the app closed mid-reply; send a message to continue)*', at: Date.now() }]
                : a.chatLog
              return {
                ...a,
                ...(chatLog ? { chatLog } : {}),
                ...usage,
                usageVersion: 1 as const,
                tools: a.tools ?? mkTools(),
                memory: a.memory ?? mkMemory(),
                status: 'idle' as const,
                escReason: undefined,
                terminalShell: a.terminalShell ?? inferLegacyTerminalShell(a.cmd),
                workspaceId: a.workspaceId && workspaces.some(w => w.id === a.workspaceId) ? a.workspaceId : activeWorkspace,
                log,
              }
            })
          const ids = new Set(restoredAgents.filter(a => a.kind !== 'chat').map(a => a.id))
          // tab groups: invalid/duplicate/chat ids become empty slots (a session
          // may live in only one group; chats live in the Chat view), slots
          // capped at 4, fully-empty groups dropped
          const seenFocus = new Set<string>()
          const rawGroups = p.groups ?? groupsFromLegacy(p).groups
          const groups = rawGroups
            .map(g => ({
              ...g,
              slots: g.slots.slice(0, 4).map(id => {
                if (!id || !ids.has(id) || seenFocus.has(id)) return null
                seenFocus.add(id)
                return id
              }),
            }))
            .filter(g => g.slots.some(Boolean))
            .map(g => ({
              ...g,
              activePane: Math.max(0, Math.min(g.activePane ?? 0, g.slots.length - 1)),
              maximizedPane: null,
              splits: g.splits ?? { row: 0.5, cols: [0.5, 0.5] },
              stacked: g.stacked ?? false,
            }))
          const activeGroup = p.activeGroup && groups.some(g => g.id === p.activeGroup)
            ? p.activeGroup
            : groups[0]?.id ?? null
          // the Routed column was removed — tasks parked there go back to Backlog
          const migrateCols = (tasks: BoardTask[]) =>
            tasks.map(t => ((t.col as string) === 'routed' ? { ...t, col: 'backlog' as const } : t))
          const workspaceData = Object.fromEntries(Object.entries(p.workspaceData ?? {}).map(([wid, d]) =>
            [wid, {
              ...d,
              tasks: migrateCols(d.tasks ?? []),
              crons: d.crons ?? [], messages: d.messages ?? [], events: d.events ?? [],
              notifications: d.notifications ?? [], minimizedIds: d.minimizedIds ?? [],
              pendingMasterNotes: d.pendingMasterNotes ?? [],
            }]))
          dispatch(s => ({
            ...s,
            tasks: migrateCols(p.tasks ?? s.tasks),
            crons: p.crons ?? s.crons,
            settings: { ...s.settings, ...(p.settings || {}) },
            toolsCatalog: p.toolsCatalog?.some(t => t.id === 'launch_session')
              ? p.toolsCatalog.concat(s.toolsCatalog.filter(seed => !p.toolsCatalog!.some(t => t.id === seed.id)))
              : s.toolsCatalog,
            agentTypes: p.agentTypes
              ? s.agentTypes
                  .map(t => ({ ...t, ...(p.agentTypes!.find(x => x.id === t.id) ?? {}), resumeCmd: t.resumeCmd, resumeFallbackCmd: t.resumeFallbackCmd, probe: t.probe } as typeof t))
                  .concat(p.agentTypes.filter(x => x.custom && !s.agentTypes.some(t => t.id === x.id)))
              : s.agentTypes,
            templates: p.templates ?? s.templates ?? [],
            mcpServers: p.mcpServers ?? s.mcpServers,
            skills: p.skills ?? s.skills,
            personas: p.personas ?? s.personas,
            skillRegistries: p.skillRegistries ?? s.skillRegistries,
            chatAgentTypes: p.chatAgentTypes ?? s.chatAgentTypes,
            agents: restoredAgents.length ? restoredAgents : s.agents,
            groups,
            activeGroup,
            minimizedIds: (p.minimizedIds ?? []).filter(id => ids.has(id)),
            workspaces,
            activeWorkspace,
            workspaceData,
            addonStorage: p.addonStorage ?? {},
            addons: (p.addons ?? s.addons).map(a => {
              const partial = a as Partial<Addon>
              const permissions = partial.permissions ?? ALL_PERMISSIONS.map(x => x.id)
              return {
                ...a,
                version: partial.version ?? '1.0.0',
                enabled: partial.enabled ?? true,
                source: partial.source ?? 'master' as const,
                permissions,
                granted: partial.granted ?? permissions,
              }
            }),
            messages: p.messages?.length ? p.messages : s.messages,
            events: p.events ?? s.events,
            notifications: p.notifications ?? s.notifications,
          }))
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
    // Parse the main partition, recovering from its backup if the primary is
    // unparseable (rethrows if the backup is bad too).
    const parseMain = async (): Promise<Partial<PersistedState>> => {
      const raw = await native.loadStateFile()
      if (!raw) return {}
      try {
        return JSON.parse(raw) as Partial<PersistedState>
      } catch (e) {
        console.error('[yaam] main state unreadable — trying backup:', e)
        const bak = await native.loadStateBackup()
        if (!bak) throw e
        const parsed = JSON.parse(bak) as Partial<PersistedState>
        dispatch(s => ({ ...s, toast: 'Restored from backup — the main state file was unreadable' }))
        return parsed
      }
    }
    // Load sessions: prefer one-file-per-session, then the legacy single
    // sessions.json partition, then the even older agents embedded in main.
    // A bad/absent source just means fewer restored sessions.
    const parseSessionAgents = async (): Promise<Agent[] | undefined> => {
      try {
        const files = await native.loadSessions()
        if (files.length) {
          const agents: Agent[] = []
          for (const raw of files) {
            try {
              const parsed = JSON.parse(raw) as { agent?: Agent }
              if (parsed.agent) agents.push(parsed.agent)
            } catch (e) {
              console.error('[yaam] a session file was unreadable — skipping:', e)
            }
          }
          if (agents.length) return agents
        }
      } catch (e) {
        console.error('[yaam] loading session files failed:', e)
      }
      try {
        const raw = await native.loadPartition('sessions')
        if (raw) return (JSON.parse(raw) as Partial<PersistedState>).agents
      } catch (e) {
        console.error('[yaam] legacy sessions partition unreadable — ignoring:', e)
      }
      return undefined
    }
    void (async () => {
      try {
        const [main, sessionAgents] = await Promise.all([parseMain(), parseSessionAgents()])
        // agents live in the sessions partition now; legacy saves embed them in main
        const merged: Partial<PersistedState> = { ...main, agents: sessionAgents ?? main.agents }
        if (Object.keys(main).length || merged.agents?.length) hydrateFrom(merged)
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
          if (v) { resolved[account] = v; keychainReadyRef.current.add(account) }
        }
        if (Object.keys(resolved).length) dispatch(s => applyResolvedSecrets(s, resolved))
      } catch (e) {
        console.error('[yaam] keychain resolve failed:', e)
      }
      hydrated.current = true
    })()
  }, [appendTail, armResponseWatch, bumpSettle, clearNeeds])

  const mainSaveTimer = useRef<number | undefined>(undefined)
  const sessionSaveTimer = useRef<number | undefined>(undefined)
  const saveFailedRef = useRef(false)
  // warn once per failure streak, not on every debounced save
  const onSaveError = useCallback((where: string, e: unknown) => {
    console.error(`[yaam] ${where} save failed:`, e)
    if (!saveFailedRef.current) {
      saveFailedRef.current = true
      dispatch(s => ({ ...s, toast: 'Could not save state to disk — recent changes may be lost on restart' }))
    }
  }, [])

  // Main (low-churn) partition: everything durable except the agents. Its deps
  // are the curated durable slices only — depending on all of `state` would
  // re-run on every transient UI change (toast/composer) and thrash the debounce.
  useEffect(() => {
    if (!hydrated.current) return
    if (mainSaveTimer.current) window.clearTimeout(mainSaveTimer.current)
    // redact secrets already safe in the keychain so the file holds no plaintext
    const main = redactSecrets(selectMainState(state), keychainReadyRef.current)
    mainSaveTimer.current = window.setTimeout(() => {
      native.saveStateFile(JSON.stringify(main)).then(() => { saveFailedRef.current = false }).catch(e => onSaveError('main', e))
    }, 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.tasks, state.crons, state.settings, state.toolsCatalog, state.agentTypes, state.templates, state.mcpServers, state.skills, state.personas, state.skillRegistries, state.chatAgentTypes,
    state.groups, state.activeGroup, state.minimizedIds,
    state.addons, state.addonStorage, state.messages, state.events, state.notifications,
    state.workspaces, state.activeWorkspace, state.workspaceData,
  ])

  // Sessions: one file per session. Terminal I/O and chat streaming fire
  // constantly, so we diff against the last-saved set and write ONLY the agents
  // whose object identity changed (agents are immutably updated, so a changed
  // reference == changed content), and delete files for removed agents. A
  // streaming session therefore rewrites just its own small file.
  const savedAgentsRef = useRef<Map<string, Agent>>(new Map())
  useEffect(() => {
    if (!hydrated.current) return
    if (sessionSaveTimer.current) window.clearTimeout(sessionSaveTimer.current)
    const agents = state.agents
    sessionSaveTimer.current = window.setTimeout(() => {
      const prev = savedAgentsRef.current
      const next = new Map<string, Agent>()
      for (const a of agents) {
        next.set(a.id, a)
        if (prev.get(a.id) !== a) {
          native.saveSession(a.id, JSON.stringify(selectSession(a))).then(() => { saveFailedRef.current = false }).catch(e => onSaveError('session', e))
        }
      }
      for (const id of prev.keys()) {
        if (!next.has(id)) native.removeSession(id).catch(() => {})
      }
      savedAgentsRef.current = next
    }, 800)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.agents])

  // Mirror credential fields into the OS keychain (debounced). Once a secret is
  // confirmed stored, mark it keychain-ready so the main writer redacts it from
  // the plaintext file; a keychain failure leaves it plaintext (no data loss).
  const secretSyncTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!hydrated.current) return
    if (secretSyncTimer.current) window.clearTimeout(secretSyncTimer.current)
    secretSyncTimer.current = window.setTimeout(() => {
      void (async () => {
        let changed = false
        for (const { account, value } of secretEntries(stateRef.current)) {
          try {
            if (value) {
              await native.secretSet(account, value)
              if (!keychainReadyRef.current.has(account)) { keychainReadyRef.current.add(account); changed = true }
            } else if (keychainReadyRef.current.delete(account)) {
              await native.secretDelete(account)
            }
          } catch (e) {
            console.error(`[yaam] keychain write failed for ${account}:`, e) // stays plaintext
          }
        }
        // re-persist redacted now that new secrets are safely in the keychain
        if (changed) native.saveStateFile(JSON.stringify(redactSecrets(selectMainState(stateRef.current), keychainReadyRef.current))).catch(() => {})
      })()
    }, 900)
  }, [state.settings.apiKey, state.chatAgentTypes, state.mcpServers])

  // flush the latest state on quit/reload so nothing inside the debounce window is lost
  useEffect(() => {
    // Persist both partitions from stateRef during page teardown, through the
    // same selectors as the debounced writers so they can never drift apart.
    const flush = () => {
      const st = stateRef.current
      native.saveStateFile(JSON.stringify(redactSecrets(selectMainState(st), keychainReadyRef.current))).catch(() => {})
      // write only sessions changed since the last debounced save
      const prev = savedAgentsRef.current
      for (const a of st.agents) {
        if (prev.get(a.id) !== a) native.saveSession(a.id, JSON.stringify(selectSession(a))).catch(() => {})
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

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
    const trimmed = command.trim()
    if (!trimmed) return null
    const id = mkId('a')
    const bin = trimmed.split(/\s+/)[0].split('/').pop() || trimmed
    const REAL_COLORS = ['#7FD1FF', '#F5C451', '#3DDC97', '#FF9B9B', '#C77DFF', '#E8A87C']
    const color = REAL_COLORS[Math.floor(Math.random() * REAL_COLORS.length)]
    const dir = cwd.trim()
    const launchType = stateRef.current.agentTypes.find(t => t.id === (typeId ?? '')) ?? typeForCommand(trimmed, stateRef.current.agentTypes)
    // Deterministic Claude sessions: Claude Code honors `--session-id <uuid>`, so
    // we mint the id ourselves and know it immediately — no fragile file
    // detection. The flag goes only into the SPAWNED command (reusing an id
    // errors "already in use"), while cmd stays clean for relaunch/resume.
    // codex/opencode have no launch-time id flag, so they keep file detection.
    let knownSessionId: string | undefined
    let spawnCommand = trimmed
    if (launchType?.probe === 'claude' && !/(^|\s)(--session-id|--resume|-r|--continue|-c)(\s|=|$)/.test(trimmed)) {
      knownSessionId = crypto.randomUUID()
      spawnCommand = trimmed.replace(/^(\s*\S+)/, `$1 --session-id ${knownSessionId}`)
    }
    const agent: Agent = {
      id, name: nameHint || bin, short: (nameHint || bin).slice(0, 2).toUpperCase(), color,
      repo: dir ? dir.split('/').pop() || dir : '~', branch: 'live',
      status: 'running', model: trimmed, kind: 'real', cmd: trimmed, cwd: dir, launchedAt: Date.now(),
      cliSessionId: knownSessionId,
      typeId: typeId ?? typeForCommand(trimmed, stateRef.current.agentTypes)?.id,
      workspaceId: workspaceId ?? stateRef.current.activeWorkspace,
      ephemeral: opts?.ephemeral, autoArchive: opts?.autoArchive, templateId: opts?.templateId,
      terminalShell: opts?.terminalShell,
      memory: mkMemory(), tools: mkTools(),
      log: [
        { t: 'sys', x: `spawning · ${trimmed}${dir ? ` @ ${dir}` : ''}` },
        // print-mode CLIs (claude -p) emit nothing until the turn completes —
        // label the silence so a long run doesn't read as a hang
        ...(opts?.ephemeral ? [{ t: 'sys' as const, x: 'one-shot run — output appears when the turn completes; this can take a while' }] : []),
        ...(!dir ? [{ t: 'warn' as const, x: 'no working folder set — running in your home directory' }] : []),
      ],
      ...defaultDetail(), usageVersion: 1,
    }
    dispatch(s => {
      const withAgent = { ...s, agents: s.agents.concat([agent]) }
      // background-workspace launches (cron) must not touch the active layout
      if (agent.workspaceId !== s.activeWorkspace) return withAgent
      return { ...focusSessionIn(withAgent, id), newSessionOpen: false }
    })
    getTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id), () => armResponseWatch(id))
    // Claude's id is known up front; only codex/opencode need file detection.
    if (!knownSessionId) probeCliSession(id, trimmed, dir, false)
    native.spawnSession(id, `${envPrefix(launchType?.env)}${spawnCommand}`, dir || undefined, undefined, undefined, opts?.terminalShell).catch(err => {
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
  const spawnTaskSession = useCallback((taskId: string, extraInstructions?: string, briefWatcher = false): string | null => {
    const st = stateRef.current
    const task = st.tasks.find(t => t.id === taskId)
    if (!task) return null
    // layered prompt: work text fills the template's {task} slot; the
    // verification contract (criteria + goal) is appended after the composed
    // prompt so template framing can't swallow or contradict it
    const work = taskWorkText(task)
      + (extraInstructions?.trim() ? `\n\nAdditional instructions from the task watcher:\n${extraInstructions.trim()}` : '')
    const contract = taskContract(task)
    let id: string | null = null
    // watcher-driven task sessions are ALWAYS one-shot: they run the task and exit
    if (task.templateId && (st.templates ?? []).some(t => t.id === task.templateId)) {
      id = launchFromTemplate(task.templateId, work, undefined, task.cwd, true, contract)
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
      id = launchSession(buildTemplateCommand(oneShot, type, work, contract), task.cwd || st.settings.defaultCwd || '', task.title.slice(0, 18), type.id, undefined, { ephemeral: true })
    }
    if (!id) return null
    taskSessionsRef.current.set(id, { taskId, workspaceId: st.activeWorkspace })
    const sessionName = stateRef.current.agents.find(a => a.id === id)?.name ?? id
    dispatch(s2 => ({
      ...s2,
      tasks: s2.tasks.map(t => t.id === taskId
        ? {
            ...t, agentId: id, agentIds: [...(t.agentIds ?? []), ...(id ? [id] : [])], scheduleAt: undefined,
            col: t.col === 'backlog' || t.col === 'done' || t.col === 'failed' ? 'progress' as const : t.col,
          }
        : t),
    }))
    armResponseWatch(id)
    pushTaskChat(taskId, 'system', `Spawned one-shot session “${sessionName}” for this task`)
    if (!task.cwd && !st.settings.defaultCwd && !(task.templateId && (st.templates ?? []).find(t => t.id === task.templateId)?.cwd)) {
      pushTaskChat(taskId, 'system',
        '⚠ No working folder set — the session runs in your home directory. If this task targets a repo, set the folder in the task spec and Relaunch.')
    }
    if (briefWatcher) {
      runWatcherRef.current(taskId,
        `A one-shot session "${sessionName}" was just spawned to work this task; it received the title, description and criteria as its prompt, with the criteria set as an explicit goal (stop condition) it must self-verify before exiting. ` +
        'Set your card note, make sure the task sits in the right column, and post one short kickoff message for the user.')
    }
    logEvent('route', id, `Spawned session for task “${task.title.slice(0, 48)}”`)
    flash(`Session spawned for “${task.title.slice(0, 28)}”`)
    return id
  }, [armResponseWatch, flash, launchFromTemplate, launchSession, logEvent, pushTaskChat])

  spawnTaskSessionRef.current = (taskId, extraInstructions) => spawnTaskSession(taskId, extraInstructions, false)

  // Deterministic start (drag to progress, schedules, no-brain fallback):
  // spawn directly, then brief the watcher.
  const spawnSessionForTask = useCallback((taskId: string) => {
    const task = stateRef.current.tasks.find(t => t.id === taskId)
    if (!task || task.agentId) return
    spawnTaskSession(taskId, undefined, true)
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
      const reply = await runAddonAgentTurn(buildCfg(st, st.monitorModel || undefined), addon, note, history, makeAddonApi(addonId))
      return reply || '(acted without a reply)'
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logEvent('escalate', null, `Addon agent "${addon.name}" error: ${msg}`)
      return `agent error: ${msg}`
    } finally {
      addonAgentBusy.current.delete(addonId)
    }
  }, [logEvent, makeAddonApi])

  runAddonAgentRef.current = runAddonAgent

  // ---- chat-mode sessions: Claude-Desktop-style agents living in panes ----
  const chatHistories = useRef<Map<string, ApiMessage[]>>(new Map())
  const chatBusy = useRef<Set<string>>(new Set())
  const mcpSessionsRef = useRef<Map<string, McpSession>>(new Map())

  // Tear down ALL per-session runtime state in one place: the xterm instance
  // (and its 5k-line scrollback), the settle timer, and the monitor/chat/task
  // registries keyed by session id. Called on delete, archive, and workspace
  // removal so nothing leaks past a session's visible lifetime.
  const disposeSessionRuntime = useCallback((id: string) => {
    disposeTerminal(id)
    const st = settleRef.current.get(id)
    if (st) window.clearTimeout(st.timer)
    settleRef.current.delete(id)
    armedRef.current.delete(id)
    lastFlaggedRef.current.delete(id)
    monitorHistories.current.delete(id)
    monitorBusy.current.delete(id)
    monitorQueue.current.delete(id)
    chatHistories.current.delete(id)
    chatBusy.current.delete(id)
    taskSessionsRef.current.delete(id)
  }, [])

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

  // keep the embedded search index in sync with chat transcripts (debounced)
  const reindexTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (reindexTimer.current) window.clearTimeout(reindexTimer.current)
    reindexTimer.current = window.setTimeout(() => {
      const docs = stateRef.current.agents
        .filter(a => a.kind === 'chat')
        .flatMap(a => (a.chatLog ?? [])
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ chatId: a.id, msgId: m.id, role: m.role, text: `${a.name}\n${m.text}` })))
      void native.chatSearchReindex(docs).catch(() => {})
    }, 1500)
  }, [state.agents])

  // connect enabled MCP servers shortly after launch (post-hydration)
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const srv of stateRef.current.mcpServers) if (srv.enabled) void connectMcp(srv.id)
      for (const reg of stateRef.current.skillRegistries) if (reg.enabled) void refreshSkillCatalog(reg.id)
    }, 1500)
    return () => window.clearTimeout(t)
  }, [connectMcp, refreshSkillCatalog])

  const runChatMessage = useCallback((agentId: string, text: string) => runChatMessageTurn({
    stateRef, dispatch, busy: chatBusy, histories: chatHistories, mcpSessions: mcpSessionsRef,
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
        const due = pool.crons.filter(c => c.on && c.lastFiredMinute !== minuteKey
          && (c.at ? c.at <= now.getTime() : cronMatches(c.schedule, now)))
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

      // scheduled tasks: spawn a session when their time arrives (all workspaces)
      const nowMs = Date.now()
      const taskPools: Array<{ wid: string; tasks: typeof st.tasks }> = [
        { wid: st.activeWorkspace, tasks: st.tasks },
        ...Object.entries(st.workspaceData).map(([wid, d]) => ({ wid, tasks: d.tasks })),
      ]
      for (const pool of taskPools) {
        for (const t of pool.tasks) {
          if (!t.scheduleAt || t.scheduleAt > nowMs || t.agentId) continue
          if (pool.wid === st.activeWorkspace && native.isTauri) {
            // active workspace: go through the watcher path (one-shot session,
            // kickoff chat, watcher ownership); clear the schedule up front so
            // a failed launch doesn't refire every tick
            dispatch(s => ({
              ...s,
              tasks: s.tasks.map(x => (x.id === t.id ? { ...x, scheduleAt: undefined } : x)),
            }))
            spawnSessionForTask(t.id)
            continue
          }
          const id = !native.isTauri ? null
            : t.templateId && (st.templates ?? []).some(x => x.id === t.templateId)
              ? launchFromTemplate(t.templateId, taskWorkText(t), pool.wid, t.cwd, true, taskContract(t))
              : (() => {
                  // mirror spawnTaskSession exactly: honor the task's agent type
                  // and force a one-shot run
                  const type = (t.typeId ? st.agentTypes.find(x => x.id === t.typeId) : undefined)
                    ?? st.agentTypes.find(x => x.enabled)
                  if (!type) return null
                  const oneShot: AgentTemplate = {
                    id: '', name: t.title.slice(0, 18), typeId: type.id, mode: 'ephemeral',
                    prompt: '{task}', systemPrompt: '', model: '', approval: 'edits', cwd: '', extraArgs: '', autoArchive: false,
                  }
                  return launchSession(buildTemplateCommand(oneShot, type, taskWorkText(t), taskContract(t)), t.cwd || st.settings.defaultCwd || '', t.title.slice(0, 18), type.id, pool.wid, { ephemeral: true })
                })()
          if (id) {
            taskSessionsRef.current.set(id, { taskId: t.id, workspaceId: pool.wid })
            armResponseWatch(id)
            pushTaskChat(t.id, 'system', `Spawned scheduled one-shot session “${t.title.slice(0, 18)}”`)
            runWatcherRef.current(t.id,
              `A scheduled one-shot session was just spawned to work this task. Set the card note, keep it in progress, and post one short kickoff message for the user.`)
          }
          // clear the schedule even on a failed launch so it doesn't refire every tick
          dispatch(s => {
            // Attach the launched worker and clear the one-time schedule in its workspace.
            const patch = (tasks: typeof s.tasks) => tasks.map(x => x.id === t.id
              ? { ...x, scheduleAt: undefined, agentId: id ?? x.agentId, col: id ? 'progress' as const : x.col }
              : x)
            if (pool.wid === s.activeWorkspace) return { ...s, tasks: patch(s.tasks) }
            const d = s.workspaceData[pool.wid]
            if (!d) return s
            return { ...s, workspaceData: { ...s.workspaceData, [pool.wid]: { ...d, tasks: patch(d.tasks) } } }
          })
          logEvent('route', id, `Scheduled task “${t.title.slice(0, 48)}” ${id ? 'started' : 'was due but no session could be launched'}`)
          notify('cron', id ? 'Scheduled task started' : 'Scheduled task could not start', t.title.slice(0, 60), id)
        }
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [armResponseWatch, launchFromTemplate, launchSession, logEvent, notify, pushTaskChat, spawnSessionForTask])

  // Master brain: run one LLM turn (chat → tools → chat), serializing turns
  const masterBusyRef = useRef(false)
  const masterQueued = useRef<{ note?: string } | null>(null)

  const lastEventRef = useRef<{ note: string; at: number } | null>(null)

  // Serialize Master turns, coalesce proactive events, and append the final reply.
  const runMaster = useCallback((eventNote?: string) => runMasterLoop({
    stateRef, dispatch, masterBusyRef, masterQueued, lastEventRef, toolApprovalsRef, userStoppedRef,
    addonAgentHistories, addonEditorHistories, launchSession, launchFromTemplate, armResponseWatch,
    sessionScreenTail, logEvent, flash, applyAgentStatus, setNeedsInput, makeAddonApi,
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

  // Expose stable UI actions while implementations read fresh state through stateRef.
  const actions = useMemo<ConductorActions>(() => ({
    setView: v => dispatch(s => ({ ...s, view: v })),
    setComposer: v => dispatch(s => ({ ...s, composer: v })),

    send: () => {
      // side effects must stay OUT of the dispatch updater — React double-
      // invokes reducers in dev, which used to schedule two Master turns
      // (the second re-answered with nothing new = double replies)
      const text = stateRef.current.composer.trim()
      if (!text) return
      dispatch(s => ({
        ...s,
        messages: s.messages.concat([{ id: mkId('u'), role: 'you', kind: 'text', text }]),
        composer: '',
      }))
      const st = stateRef.current.settings
      if (hasCreds(st) && st.masterEnabled) {
        later(50, () => { void runMaster() })
      } else {
        later(300, () => dispatch(s2 => ({
          ...s2,
          messages: s2.messages.concat([{
            id: mkId('m'), role: 'master', kind: 'text',
            text: hasCreds(s2.settings)
              ? 'My brain is switched off — enable “LLM Master” in Settings → Master Brain and I’ll take it from there.'
              : 'I need a brain first: pick a provider in Settings → Master Brain (API key, or AWS Bedrock with your credential chain) and flip the LLM Master toggle, then ask me again.',
          }]),
        })))
      }
    },

    focusComposer: () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-composer]')
      el?.focus()
    },

    setActivePane: i => dispatch(s => {
      const ag = activeGroupOf(s)
      if (!ag || i < 0 || i >= ag.slots.length) return s
      const id = ag.slots[i]
      return {
        ...withActiveGroup(s, g => ({ ...g, activePane: i })),
        agents: id ? s.agents.map(a => (a.id === id ? { ...a, attention: false } : a)) : s.agents,
      }
    }),

    focusTab: id => dispatch(s => focusSessionIn(s, id)),

    activateGroup: gid => dispatch(s => (s.groups.some(g => g.id === gid)
      ? { ...s, activeGroup: gid, view: 'workspace' }
      : s)),

    closeGroup: gid => dispatch(s => {
      const groups = s.groups.filter(g => g.id !== gid)
      return {
        ...s,
        groups,
        activeGroup: s.activeGroup === gid ? groups[0]?.id ?? null : s.activeGroup,
      }
    }),

    // layout changes apply to the ACTIVE group only — other tab groups keep
    // their own pane arrangement (each group remembers its layout, Chrome-style)
    setPaneLayout: (n, stacked) => dispatch(s => {
      const count = Math.max(1, Math.min(4, Math.round(n)))
      if (!activeGroupOf(s)) {
        const g = mkGroup(Array(count).fill(null), !!stacked)
        return { ...s, groups: s.groups.concat([g]), activeGroup: g.id, view: 'workspace' }
      }
      return {
        ...withActiveGroup(s, g => {
          // keep visible sessions in order, then pad with empty slots
          const kept = g.slots.filter((id): id is string => id !== null).slice(0, count)
          const slots: (string | null)[] = kept.concat(Array(count - kept.length).fill(null))
          return {
            ...g, slots,
            stacked: !!stacked,
            activePane: Math.min(g.activePane, count - 1),
            maximizedPane: null,
          }
        }),
        view: 'workspace',
      }
    }),

    assignPane: (i, id) => dispatch(s => {
      const ag = activeGroupOf(s)
      if (!ag) {
        // empty grid with no group yet — assigning creates one
        const g = mkGroup([id])
        return {
          ...s,
          groups: s.groups.concat([g]),
          activeGroup: g.id,
          agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)),
          minimizedIds: s.minimizedIds.filter(x => x !== id),
          view: 'workspace',
        }
      }
      if (i < 0 || i >= ag.slots.length) return s
      // a session lives in at most one group — pull it out of any other slot
      const cleared = s.groups.map(g => (g.slots.includes(id)
        ? { ...g, slots: g.slots.map(x => (x === id ? null : x)), maximizedPane: null }
        : g))
      const groups = cleared
        .map(g => (g.id === ag.id
          ? { ...g, slots: g.slots.map((x, k) => (k === i ? id : x)), activePane: i, maximizedPane: null }
          : g))
        .filter(g => g.slots.some(Boolean) || g.id === s.activeGroup)
      return {
        ...s, groups,
        agents: s.agents.map(a => (a.id === id ? { ...a, archived: false, attention: false } : a)),
        minimizedIds: s.minimizedIds.filter(x => x !== id),
        view: 'workspace',
      }
    }),

    closePane: i => dispatch(s => {
      const ag = activeGroupOf(s)
      if (!ag || i < 0 || i >= ag.slots.length) return s
      if (ag.slots.length <= 1) {
        // last pane: dissolve the group; its session returns to a loose tab
        const groups = s.groups.filter(g => g.id !== ag.id)
        return { ...s, groups, activeGroup: groups[0]?.id ?? null }
      }
      return withActiveGroup(s, g => {
        const slots = g.slots.slice()
        slots.splice(i, 1)
        return { ...g, slots, activePane: Math.min(g.activePane, slots.length - 1), maximizedPane: null }
      })
    }),

    toggleMaximize: i => dispatch(s => withActiveGroup(s, g => (i < 0 || i >= g.slots.length ? g : {
      ...g,
      maximizedPane: g.maximizedPane === i ? null : i,
      activePane: i,
    }))),

    minimizePane: i => dispatch(s => {
      const ag = activeGroupOf(s)
      const id = ag?.slots[i]
      if (!ag || !id) return s
      // keep the layout — the slot goes empty, ready for reassignment
      const next = withActiveGroup(s, g => ({
        ...g,
        slots: g.slots.map((x, k) => (k === i ? null : x)),
        maximizedPane: null,
      }))
      return {
        ...next,
        minimizedIds: s.minimizedIds.includes(id) ? s.minimizedIds : s.minimizedIds.concat([id]),
      }
    }),

    // restoring from the dock: focusSessionIn already prefers an empty slot of
    // the active group and otherwise opens the session as its own tab
    restoreSession: id => dispatch(s => focusSessionIn(s, id)),

    setRowSplit: v => dispatch(s => withActiveGroup(s, g => ({ ...g, splits: { ...g.splits, row: v } }))),
    setColSplit: (row, v) => dispatch(s => withActiveGroup(s, g => {
      const cols = g.splits.cols.slice()
      cols[row] = v
      return { ...g, splits: { ...g.splits, cols } }
    })),

    renameSession: (id, name) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, name: name.trim() || a.name, short: (name.trim() || a.name).slice(0, 2).toUpperCase(), nameIsDefault: false }
        : a),
    })),

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

    openPanel: (id, tab) => dispatch(s => ({ ...s, panel: { agentId: id, tab: tab || 'memory' } })),
    setPanelTab: tab => dispatch(s => (s.panel ? { ...s, panel: { ...s.panel, tab } } : s)),
    closePanel: () => dispatch(s => ({ ...s, panel: null })),

    toggleMem: (aid, mid) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === aid
        ? { ...a, memory: a.memory.map(m => (m.id === mid ? { ...m, on: !m.on } : m)) }
        : a),
    })),

    toggleTool: (aid, tid) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === aid
        ? { ...a, tools: a.tools.map(t => (t.id === tid ? { ...t, on: !t.on } : t)) }
        : a),
    })),

    cyclePerm: (aid, tid) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === aid
        ? {
            ...a,
            tools: a.tools.map(t => t.id === tid
              ? { ...t, perm: PERM_ORDER[(PERM_ORDER.indexOf(t.perm) + 1) % PERM_ORDER.length] }
              : t),
          }
        : a),
    })),

    toggleCron: id => dispatch(s => ({
      ...s,
      crons: s.crons.map(c => (c.id === id ? { ...c, on: !c.on } : c)),
    })),

    cycleCatalogPerm: id => dispatch(s => ({
      ...s,
      toolsCatalog: s.toolsCatalog.map(t => t.id === id
        ? { ...t, perm: PERM_ORDER[(PERM_ORDER.indexOf(t.perm) + 1) % PERM_ORDER.length] }
        : t),
    })),

    answerPrompt: (aid, num) => {
      const st = stateRef.current
      const agent = st.agents.find(a => a.id === aid)
      const msg = [...st.messages].reverse().find(m => m.kind === 'escalate' && m.escFor === aid && m.esc && !m.esc.resolved)
      const esc = msg?.esc
      if (!agent || !esc?.options?.length) return
      const target = esc.options.find(o => o.num === num)
      if (!target) return
      const delta = num - (esc.cursorNum ?? 1)
      const moves = delta > 0 ? '\x1b[B'.repeat(delta) : '\x1b[A'.repeat(-delta)
      if (moves) native.writeSession(aid, moves).catch(() => {})
      window.setTimeout(() => { native.writeSession(aid, '\r').catch(() => {}) }, 200)
      lastFlaggedRef.current.delete(aid)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'you' as const, x: `chose ${num}. ${target.label}` }]) }
          : a),
        messages: s.messages.map(m => m === msg && m.esc
          ? { ...m, esc: { ...m.esc, resolved: true, decision: 'approved' as const, choice: `${num}. ${target.label}` } }
          : m),
      }))
      flash(`Chose “${target.label}”`)
      logEvent('done', aid, `Answered prompt · ${num}. ${target.label}`)
      armResponseWatch(aid)
    },

    approve: aid => {
      const agent = stateRef.current.agents.find(a => a.id === aid)
      // answer the prompt: Enter accepts the default / highlighted option
      if (agent?.kind === 'real') native.writeSession(aid, '\r').catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'sys' as const, x: 'approved by you' }]) }
          : a),
        messages: s.messages.map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'approved' as const } } : m)),
      }))
      flash(`Approved — ${agent?.name || 'agent'} resumed`)
      logEvent('done', aid, 'Approved · prompt accepted')
    },

    deny: aid => {
      const agent = stateRef.current.agents.find(a => a.id === aid)
      // Escape cancels the prompt
      if (agent?.kind === 'real') native.writeSession(aid, '\x1b').catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, escReason: undefined, log: a.log.concat([{ t: 'sys' as const, x: 'denied · prompt cancelled' }]) }
          : a),
        messages: s.messages.map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'denied' as const } } : m)),
      }))
      flash(`Denied — prompt cancelled`)
      logEvent('escalate', aid, 'Denied · prompt cancelled')
    },

    gotoNeeds: () => dispatch(s => {
      const needsAgent = s.agents.find(a => ((a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace) && (a.status === 'needs' || a.status === 'error'))
      return needsAgent ? focusSessionIn(s, needsAgent.id) : s
    }),

    openPalette: () => dispatch(s => ({ ...s, paletteOpen: true, paletteQuery: '' })),
    closePalette: () => dispatch(s => ({ ...s, paletteOpen: false, paletteQuery: '' })),
    setPaletteQuery: q => dispatch(s => ({ ...s, paletteQuery: q })),

    toggleNotif: () => dispatch(s => ({ ...s, notifOpen: !s.notifOpen })),
    readAllNotif: () => dispatch(s => ({ ...s, notifications: s.notifications.map(n => ({ ...n, read: true })) })),
    clickNotif: n => dispatch(s => {
      const next = {
        ...s,
        notifications: s.notifications.map(x => (x.id === n.id ? { ...x, read: true } : x)),
        notifOpen: false,
      }
      if (n.agentId && s.agents.some(a => a.id === n.agentId)) {
        return focusSessionIn(next, n.agentId)
      }
      if (n.kind === 'cron') return { ...next, view: 'crons' }
      return next
    }),

    openAgent: id => dispatch(s => ({ ...s, drawer: { kind: 'agent', agentId: id } })),
    openDiff: id => dispatch(s => ({ ...s, drawer: { kind: 'diff', agentId: id } })),
    closeDrawer: () => dispatch(s => ({ ...s, drawer: null })),

    approveDiff: id => {
      dispatch(s => ({
        ...s,
        drawer: null,
        tasks: s.tasks.map(t => (t.agentId === id && t.col === 'review' ? { ...t, col: 'done' as const } : t)),
      }))
      logEvent('done', id, 'Approved changes')
      flash('Changes approved')
    },

    requestChanges: id => {
      dispatch(s => ({ ...s, drawer: null }))
      logEvent('edit', id, 'Requested changes on the diff')
      flash('Requested changes')
    },

    toggleAgentType: id => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(x => (x.id === id ? { ...x, enabled: !x.enabled } : x)),
    })),

    addMcpServer: (name, url, headers) => {
      const id = mkId('mcp')
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.concat([{
          id, name: name.trim() || url.trim(), url: url.trim(), headers: headers?.trim() || undefined, enabled: true,
        }]),
      }))
      later(50, () => { void connectMcp(id) })
    },

    updateMcpServer: (id, patch) => {
      dispatch(s => ({
        ...s,
        mcpServers: s.mcpServers.map(x => (x.id === id ? { ...x, ...patch } : x)),
      }))
      if (patch.url !== undefined || patch.headers !== undefined || patch.enabled === true) later(50, () => { void connectMcp(id) })
      if (patch.enabled === false) mcpSessionsRef.current.delete(id)
    },

    removeMcpServer: id => {
      mcpSessionsRef.current.delete(id)
      dispatch(s => ({ ...s, mcpServers: s.mcpServers.filter(x => x.id !== id) }))
    },

    connectMcpServer: id => connectMcp(id),

    addSkill: () => {
      const id = mkId('sk')
      dispatch(s => ({
        ...s,
        skills: s.skills.concat([{ id, name: `skill-${s.skills.length + 1}`, description: '', body: '' }]),
      }))
      return id
    },

    updateSkill: (id, patch) => dispatch(s => ({
      ...s,
      skills: s.skills.map(x => (x.id === id ? { ...x, ...patch } : x)),
    })),

    removeSkill: id => dispatch(s => ({ ...s, skills: s.skills.filter(x => x.id !== id) })),

    addPersona: () => {
      const id = mkId('pe')
      dispatch(s => ({
        ...s,
        personas: s.personas.concat([{ id, name: `persona-${s.personas.length + 1}`, description: '', body: '' }]),
      }))
      return id
    },

    updatePersona: (id, patch) => dispatch(s => ({
      ...s,
      personas: s.personas.map(x => (x.id === id ? { ...x, ...patch } : x)),
    })),

    removePersona: id => dispatch(s => ({ ...s, personas: s.personas.filter(x => x.id !== id) })),

    addSkillRegistry: (name, url) => {
      const id = mkId('sr')
      dispatch(s => ({
        ...s,
        skillRegistries: s.skillRegistries.concat([{
          id, name: name.trim() || (/^https?:/.test(url) ? url.split('/')[4] ?? 'registry' : 'local'), url: url.trim(), enabled: true,
        }]),
      }))
      later(50, () => { void refreshSkillCatalog(id) })
    },

    updateSkillRegistry: (id, patch) => {
      dispatch(s => ({
        ...s,
        skillRegistries: s.skillRegistries.map(x => (x.id === id ? { ...x, ...patch } : x)),
      }))
      if (patch.url !== undefined || patch.enabled === true) later(50, () => { void refreshSkillCatalog(id) })
      if (patch.enabled === false) skillCatalogsRef.current.delete(id)
    },

    removeSkillRegistry: id => {
      skillCatalogsRef.current.delete(id)
      dispatch(s => ({ ...s, skillRegistries: s.skillRegistries.filter(x => x.id !== id) }))
    },

    refreshSkillRegistry: id => refreshSkillCatalog(id),

    addChatAgentType: () => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.concat([{
        id: mkId('ct'), name: `chat-${s.chatAgentTypes.length + 1}`, provider: 'anthropic',
        model: 'claude-sonnet-5', enabled: true,
      }]),
    })),

    updateChatAgentType: (id, patch) => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })),

    deleteChatAgentType: id => dispatch(s => ({
      ...s,
      chatAgentTypes: s.chatAgentTypes.filter(t => t.id !== id),
    })),

    newChatSession: (name, cwd, chatTypeId, model, personaId, skillSourceIds) => {
      const id = mkId('a')
      const dir = (cwd ?? stateRef.current.settings.defaultCwd ?? '').trim()
      const chatType = stateRef.current.chatAgentTypes.find(t => t.id === chatTypeId)
        ?? stateRef.current.chatAgentTypes.find(t => t.enabled)
        ?? stateRef.current.chatAgentTypes[0]
      const agent: Agent = {
        id, name: name?.trim() || chatType?.name || 'chat', short: (name?.trim() || chatType?.name || 'CH').slice(0, 2).toUpperCase(),
        color: '#7FD1FF', repo: dir ? dir.split('/').pop() || dir : '~', branch: 'chat',
        status: 'idle', model: chatType ? `${chatType.name} · ${model || chatType.model}` : 'chat agent', kind: 'chat', cwd: dir,
        chatTypeId: chatType?.id,
        chatModel: model || chatType?.model,
        nameIsDefault: !name?.trim(),
        personaId,
        skillSourceIds,
        workspaceId: stateRef.current.activeWorkspace,
        memory: mkMemory(), tools: mkTools(), log: [],
        chatLog: [{
          id: mkId('cm'), role: 'assistant', at: Date.now(),
          text: `Hi — I'm a chat agent${dir ? ` working in \`${dir}\`` : ''}. I can browse and edit files, run commands and scripts, load skills, and call your MCP servers. What are we doing?`,
        }],
        ...defaultDetail(), usageVersion: 1,
      }
      dispatch(s => ({ ...s, agents: s.agents.concat([agent]), activeChatId: id, view: 'chat' }))
      logEvent('route', id, `Started chat agent “${agent.name}”`)
      return id
    },

    openChat: id => dispatch(s => ({ ...s, activeChatId: id, ...(id ? { view: 'chat' as const } : {}) })),

    sendChatMessage: (agentId, text) => {
      const msg = text.trim()
      if (msg) void runChatMessage(agentId, msg)
    },

    toggleSetting: k => dispatch(s => ({ ...s, settings: { ...s.settings, [k]: !s.settings[k] } })),
    updateSettings: patch => dispatch(s => ({ ...s, settings: { ...s.settings, ...patch } })),
    setAgentTypeCmd: (id, cmd) => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(t => (t.id === id ? { ...t, model: cmd } : t)),
    })),
    updateAgentType: (id, patch) => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })),
    addAgentType: () => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.concat([{
        id: mkId('custom'),
        name: 'New agent', color: '#7FD1FF', model: '', tools: 0,
        desc: 'Custom agent type.', enabled: true, custom: true, env: '',
      }]),
    })),
    deleteAgentType: id => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.filter(t => t.id !== id),
    })),

    startCardDrag: id => { dragId.current = id },
    enterCol: col => dispatch(s => (s.dragOverCol === col ? s : { ...s, dragOverCol: col })),
    dropTo: col => {
      const id = dragId.current
      dragId.current = null
      const prev = id ? stateRef.current.tasks.find(t => t.id === id) : undefined
      dispatch(s => id
        ? { ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, col } : t)), dragOverCol: null }
        : { ...s, dragOverCol: null })
      if (prev && prev.col !== col) fireAddonHookRef.current('onTaskMoved', { taskId: prev.id, title: prev.title, col, from: prev.col })
      if (id && col === 'progress') {
        const task = stateRef.current.tasks.find(t => t.id === id)
        if (task && !task.agentId) later(50, () => spawnSessionForTask(id))
      }
    },

    startTask: taskId => startTaskViaWatcher(taskId),

    restartTask: taskId => {
      const t = stateRef.current.tasks.find(x => x.id === taskId)
      if (!t) return
      const prev = t.agentId ? stateRef.current.agents.find(a => a.id === t.agentId) : undefined
      if (prev && (prev.status === 'running' || prev.status === 'needs')) {
        userStoppedRef.current.add(prev.id)
        native.killSession(prev.id).catch(() => {})
      }
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(x => (x.id === taskId ? { ...x, agentId: null } : x)),
      }))
      pushTaskChat(taskId, 'system', `Relaunching — previous session${prev ? ` “${prev.name}”` : ''} detached`)
      later(50, () => spawnSessionForTask(taskId))
    },
    createTask: input => {
      const id = mkId('t')
      dispatch(s => ({
        ...s,
        tasks: s.tasks.concat([{
          id,
          title: input.title.trim().slice(0, 120),
          col: 'backlog',
          agentId: null,
          description: input.description.trim(),
          criteria: input.criteria.map(c => c.trim()).filter(Boolean),
          templateId: input.templateId || undefined,
          typeId: input.typeId || undefined,
          cwd: input.cwd?.trim() || undefined,
          chat: [{ id: mkId('tc'), role: 'system', text: 'Task created', at: Date.now() }],
        }]),
      }))
      flash(`Task “${input.title.trim().slice(0, 32)}” created`)
    },
    updateTask: (id, patch) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => (t.id === id ? { ...t, ...patch, title: (patch.title ?? t.title).trim() || t.title } : t)),
    })),
    sendTaskChat: (taskId, text) => {
      const msg = text.trim()
      if (!msg) return
      pushTaskChat(taskId, 'user', msg)
      dispatch(s => ({
        ...s,
        tasks: s.tasks.map(t => (t.id === taskId ? { ...t, awaitingUser: false } : t)),
      }))
      void runWatcher(taskId, `[user message] ${msg}`)
    },
    draftTask: async input => {
      const st = stateRef.current.settings
      if (!(st.masterEnabled && hasCreds(st))) return null
      return draftTaskSpec(buildCfg(st, st.monitorModel || undefined), input.title, input.description, input.criteria)
    },
    renameTask: (id, title) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => (t.id === id ? { ...t, title: title.trim() || t.title } : t)),
    })),
    deleteTask: id => {
      watcherHistories.current.delete(id)
      watcherQueue.current.delete(id)
      for (const [sessionId, binding] of taskSessionsRef.current) {
        if (binding.taskId === id) taskSessionsRef.current.delete(sessionId)
      }
      dispatch(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== id) }))
    },

    addTemplate: () => {
      const id = mkId('tpl')
      dispatch(s => ({
        ...s,
        templates: (s.templates ?? []).concat([{
          id, name: `template-${(s.templates ?? []).length + 1}`,
          typeId: s.agentTypes.find(t => t.enabled)?.id ?? 'claude',
          mode: 'ephemeral', prompt: '{task}', systemPrompt: '', model: '',
          approval: 'edits', cwd: '', extraArgs: '', autoArchive: false,
        }]),
      }))
      return id
    },
    updateTemplate: (id, patch) => dispatch(s => ({
      ...s,
      templates: (s.templates ?? []).map(t => t.id === id ? { ...t, ...patch } : t),
    })),
    deleteTemplate: id => dispatch(s => ({
      ...s,
      templates: (s.templates ?? []).filter(t => t.id !== id),
      tasks: s.tasks.map(t => t.templateId === id ? { ...t, templateId: undefined } : t),
      crons: s.crons.map(c => c.templateId === id ? { ...c, templateId: undefined } : c),
    })),
    runTemplate: (id, task) => {
      const lid = launchFromTemplate(id, task)
      if (lid) flash('Session launched from template')
    },
    scheduleTask: (taskId, at, templateId) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => t.id === taskId
        ? { ...t, scheduleAt: at ?? undefined, ...(templateId !== undefined ? { templateId: templateId ?? undefined } : {}) }
        : t),
    })),

    addCron: cron => {
      dispatch(s => ({
        ...s,
        crons: s.crons.concat([{ ...cron, id: mkId('c'), on: true, built: false, last: '—' }]),
      }))
      flash('Schedule created')
      logEvent('cron', null, `Created schedule ${cron.name}`)
    },
    deleteCron: id => dispatch(s => ({ ...s, crons: s.crons.filter(c => c.id !== id) })),

    openAddon: id => dispatch(s => ({ ...s, view: 'addon', activeAddon: id })),

    toggleAddon: id => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    })),

    toggleAddonGrant: (id, perm) => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => a.id === id
        ? { ...a, granted: a.granted.includes(perm) ? a.granted.filter(g => g !== perm) : a.granted.concat([perm]) }
        : a),
    })),

    installAddonFromFile: () => {
      void (async () => {
        try {
          const path = await native.pickFile()
          if (!path) return
          const json = await native.readTextFile(path)
          installPackage(json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromFolder: () => {
      void (async () => {
        try {
          const dir = await native.pickFolder()
          if (!dir) return
          let manifest: string | null = null
          for (const cand of ['addon.yaml', 'addon.yml', 'addon.json']) {
            try {
              manifest = await native.readTextFile(`${dir}/${cand}`)
              break
            } catch { /* try the next manifest name */ }
          }
          if (!manifest) throw new Error('no addon.yaml / addon.yml / addon.json in that folder')
          const json = await loadAddonFolder(manifest, rel => native.readTextFile(`${dir}/${rel}`))
          installPackage(json, 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    installAddonFromUrl: url => {
      void (async () => {
        try {
          // registries can be local: non-http entries are filesystem paths
          const json = /^https?:\/\//.test(url) ? await native.httpGetText(url) : await native.readTextFile(url)
          installPackage(json, /^https?:\/\//.test(url) ? 'url' : 'file')
        } catch (e) {
          flash(`Install failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },

    generateAddon: async prompt => {
      const st = stateRef.current.settings
      if (!(st.masterEnabled && hasCreds(st))) return 'No brain configured — enable LLM Master in Settings first.'
      try {
        const json = await generateAddonPackage(buildCfg(st), prompt)
        installPackage(json, 'master')
        return ''
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },

    sendAddonChat: (id, text) => { void sendAddonChatImpl(id, text) },

    addonRpc: (addonId, method, args) => dispatchAddonRpc(makeAddonApi(addonId), method, args),

    updateAddonMeta: (id, patch) => dispatch(s => ({
      ...s,
      addons: s.addons.map(a => (a.id === id ? { ...a, ...patch } : a)),
    })),

    exportAddon: id => {
      void (async () => {
        const addon = stateRef.current.addons.find(a => a.id === id)
        if (!addon) return
        try {
          const path = await native.pickSavePath(`${addon.name.replace(/[^a-z0-9-]/gi, '-')}.yaam.json`)
          if (!path) return
          await native.writeTextFile(path, exportAddonPackage(addon))
          flash(`Exported ${addon.name}`)
        } catch (e) {
          flash(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })()
    },
    removeAddon: id => {
      addonAgentHistories.current.delete(id)
      addonEditorHistories.current.delete(id)
      dispatch(s => {
        const addonStorage = { ...s.addonStorage }
        delete addonStorage[id]
        const addonChats = { ...s.addonChats }
        delete addonChats[id]
        return {
          ...s,
          addons: s.addons.filter(a => a.id !== id),
          addonStorage, addonChats,
          view: s.activeAddon === id ? 'workspace' : s.view,
          activeAddon: s.activeAddon === id ? null : s.activeAddon,
        }
      })
    },

    switchWorkspace: id => {
      // Master events that queued while this workspace was inactive
      const pending = stateRef.current.workspaceData[id]?.pendingMasterNotes ?? []
      dispatch(s => switchWorkspaceIn(s, id, MASTER_GREETING))
      if (pending.length) {
        later(600, () => {
          if (stateRef.current.activeWorkspace !== id) return
          void runMaster(`[events queued while this workspace was in the background]\n${pending.join('\n\n')}\n\nSummarize these for the user (grouped, brief).`)
        })
      }
    },

    createWorkspace: name => {
      const id = mkId('ws')
      const trimmed = name.trim() || `Workspace ${stateRef.current.workspaces.length + 1}`
      dispatch(s => switchWorkspaceIn(
        { ...s, workspaces: s.workspaces.concat([{ id, name: trimmed }]) },
        id, MASTER_GREETING,
      ))
      flash(`Workspace “${trimmed}” created`)
    },

    renameWorkspace: (id, name) => dispatch(s => ({
      ...s,
      workspaces: s.workspaces.map(w => (w.id === id ? { ...w, name: name.trim() || w.name } : w)),
    })),

    deleteWorkspace: id => {
      const s0 = stateRef.current
      if (s0.workspaces.length <= 1) {
        flash('Cannot delete the last workspace')
        return
      }
      // kill the workspace's sessions and tear down all their runtime state
      for (const a of s0.agents.filter(a => a.workspaceId === id)) {
        userStoppedRef.current.add(a.id)
        native.killSession(a.id).catch(() => {})
        disposeSessionRuntime(a.id)
        native.removeSession(a.id).catch(() => {})
      }
      dispatch(s => {
        let next = s
        if (s.activeWorkspace === id) {
          const fallback = s.workspaces.find(w => w.id !== id)!
          next = switchWorkspaceIn(s, fallback.id, MASTER_GREETING)
        }
        const workspaceData = { ...next.workspaceData }
        delete workspaceData[id]
        return {
          ...next,
          workspaces: next.workspaces.filter(w => w.id !== id),
          workspaceData,
          agents: next.agents.filter(a => a.workspaceId !== id),
        }
      })
      flash('Workspace deleted')
    },

    openNewSession: () => dispatch(s => ({ ...s, newSessionOpen: true })),
    closeNewSession: () => dispatch(s => ({ ...s, newSessionOpen: false })),

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

    resolveToolApproval: (id, approve) => {
      const pa = stateRef.current.pendingToolApprovals.find(x => x.id === id)
      dispatch(s => ({ ...s, pendingToolApprovals: s.pendingToolApprovals.filter(x => x.id !== id) }))
      if (!pa) return
      if (approve) toolApprovalsRef.current.add(pa.toolId)
      later(50, () => {
        void runMaster(approve
          ? `[the user approved one use of "${pa.toolId}" — retry the blocked call now]`
          : `[the user denied "${pa.toolId}" — do not retry it; adjust your plan or ask the user]`)
      })
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
  }), [appendTail, armResponseWatch, bumpSettle, clearNeeds, connectMcp, disposeSessionRuntime, flash, installPackage, later, launchFromTemplate, launchSession, logEvent, makeAddonApi, probeCliSession, pushTaskChat, refreshSkillCatalog, runChatMessage, runMaster, runWatcher, sendAddonChatImpl, spawnSessionForTask, startTaskViaWatcher])

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

  return (
    <StoreCtx.Provider value={conductorStore}>
      <StateCtx.Provider value={state}>
        <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
      </StateCtx.Provider>
    </StoreCtx.Provider>
  )
}

export { useConductor, useConductorSelector, useActions } from './store/hooks'

export type { LogLine }
