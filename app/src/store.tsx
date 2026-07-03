/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  Addon, Agent, AppState, BoardCol, Cron, EscOption, EventType, LogLine,
  NotifKind, Notification, Panel, PersistedState, View,
} from './types'
import { defaultDetail, mkMemory, mkTools, PERM_ORDER, seedState } from './data'
import * as native from './native'
import { buildCfg, runMasterTurn } from './master'
import type { ApiMessage, MasterExec } from './master'
import { runMonitorTurn } from './monitor'
import type { MonitorExec } from './monitor'
import { disposeTerminal, getTerminal, isAltScreen, readScreen, repaintSession } from './terminals'
import { ActionsCtx, StateCtx } from './context'

type Updater = (s: AppState) => AppState

function reducer(s: AppState, f: Updater): AppState {
  return f(s)
}

export interface ConductorActions {
  setView: (v: View) => void
  setComposer: (v: string) => void
  send: () => void
  focusComposer: () => void
  setActivePane: (i: number) => void
  focusTab: (id: string) => void
  addPane: () => void
  closePane: (i: number) => void
  toggleMaximize: (i: number) => void
  minimizePane: (i: number) => void
  restoreSession: (id: string) => void
  setRowSplit: (v: number) => void
  setColSplit: (row: number, v: number) => void
  renameSession: (id: string, name: string) => void
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  startTask: (taskId: string) => void
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
  toggleIntegration: (id: string) => void
  toggleAgentType: (id: string) => void
  toggleSetting: (k: 'autoRoute' | 'approveDestructive' | 'followMode') => void
  updateSettings: (patch: Partial<AppState['settings']>) => void
  setAgentTypeCmd: (id: string, cmd: string) => void
  updateAgentType: (id: string, patch: Partial<AppState['agentTypes'][number]>) => void
  addAgentType: () => void
  deleteAgentType: (id: string) => void
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  addTask: () => void
  renameTask: (id: string, title: string) => void
  deleteTask: (id: string) => void
  addCron: (cron: Omit<Cron, 'id' | 'on' | 'built' | 'last'>) => void
  deleteCron: (id: string) => void
  openAddon: (id: string) => void
  removeAddon: (id: string) => void
  openNewSession: () => void
  closeNewSession: () => void
  newRealSession: (command: string, cwd: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}


import {
  KEYMAP, PROMPT_RE, QUESTION_LINE_RE, QUESTION_MARK_LINE_RE, TUI_PROMPT_RE,
  cronMatches, envPrefix, extractOptions, focusSessionIn, humanizeCron, mkId,
  sendLineToSession, spawnAgentProcess, typeForCommand, wait,
} from './state-lib'

export { cronMatches, humanizeCron } from './state-lib'

export function ConductorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, seedState)
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // set by the Master/monitor runners below; refs avoid declaration cycles
  const masterEventRef = useRef<(note: string) => void>(() => {})
  const monitorEventRef = useRef<(id: string, note: string) => Promise<void> | void>(() => {})

  useEffect(() => {
    const timers = pending.current
    return () => {
      timers.forEach(t => window.clearTimeout(t))
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const later = useCallback((ms: number, fn: () => void) => {
    pending.current.push(window.setTimeout(fn, ms))
  }, [])

  const flash = useCallback((t: string) => {
    dispatch(s => ({ ...s, toast: t }))
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => dispatch(s => ({ ...s, toast: null })), 2600)
  }, [])

  const logEvent = useCallback((type: EventType, agentId: string | null, text: string) => {
    dispatch(s => ({
      ...s,
      events: [{ id: mkId('e'), type, agentId, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]
        .concat(s.events)
        .slice(0, 200),
    }))
  }, [])

  const notify = useCallback((kind: NotifKind, title: string, detail: string, agentId: string | null) => {
    dispatch(s => ({
      ...s,
      notifications: [{
        id: mkId('n'), kind, title, detail,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        read: false, agentId,
      }].concat(s.notifications).slice(0, 30),
    }))
  }, [])

  // Agents → Master / user leg. We never react to individual lines: each
  // session has a settle watcher, and only once output has been quiet for a
  // few seconds do we look at the tail. If the LLM Master is enabled, IT
  // decides whether the session is waiting on the user (flag_needs_input);
  // without it, a prompt-shaped final line is required.
  // armed watch: snapshot of the screen/tail at arm time — we only relay once
  // the content has actually changed AND the TUI is no longer busy
  const armedRef = useRef<Map<string, { snapshot: string; at: number }>>(new Map())
  const settleRef = useRef<Map<string, { since: number; timer: number }>>(new Map())

  const sessionScreenTail = useCallback((id: string): string => {
    const lines = isAltScreen(id)
      ? readScreen(id)
      : (stateRef.current.agents.find(a => a.id === id)?.log ?? []).map(l => l.x)
    return lines.filter(Boolean).slice(-10).join('\n') || '(no output)'
  }, [])

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

  const setNeedsInput = useCallback((id: string, question: string, options?: EscOption[], cursorNum?: number) => {
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || agent.status !== 'running') return
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id ? { ...a, status: 'needs' as const, escReason: question, attention: true } : a),
      messages: s.messages.concat([{
        id: mkId('m'), role: 'master', kind: 'escalate', escFor: id,
        esc: {
          name: agent.name, color: agent.color, repo: agent.repo, reason: question,
          resolved: false, decision: null,
          options: options?.length ? options : undefined,
          cursorNum: cursorNum ?? 1,
        },
      }]),
    }))
    logEvent('escalate', id, `${agent.name} is asking for input: ${question.slice(0, 64)}`)
    notify('escalate', `${agent.name} needs your input`, question.slice(0, 80), id)
  }, [logEvent, notify])

  const lastFlaggedRef = useRef<Map<string, string>>(new Map())

  // shared by Master's update_agent_status tool and the per-session monitors
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

  const runMonitor = useCallback(async (id: string, note: string) => {
    const st = stateRef.current.settings
    if (!(st.masterEnabled && st.apiKey && st.followMode)) return
    if (monitorBusy.current.has(id)) {
      monitorQueue.current.set(id, note)
      return
    }
    monitorBusy.current.add(id)
    try {
      let pending: string | undefined = note
      while (pending !== undefined) {
        const current = pending
        pending = undefined
        const agent = stateRef.current.agents.find(a => a.id === id)
        if (!agent) break
        let history = monitorHistories.current.get(id)
        if (!history) {
          history = []
          monitorHistories.current.set(id, history)
        }
        const exec: MonitorExec = {
          updateStatus: (task, summary, actionNeeded) => {
            applyAgentStatus(id, task, summary, actionNeeded)
            return 'status updated'
          },
          flagNeedsInput: question => {
            const screen = isAltScreen(id) ? readScreen(id) : (stateRef.current.agents.find(a => a.id === id)?.log ?? []).slice(-14).map(l => l.x)
            const { options, cursorNum } = extractOptions(screen)
            setNeedsInput(id, question || 'waiting for input', options, cursorNum)
            return 'flagged as needing input'
          },
          reportToMaster: (digest, importance) => {
            const a = stateRef.current.agents.find(x => x.id === id)
            dispatch(s2 => ({
              ...s2,
              agents: s2.agents.map(x => (x.id === id ? { ...x, attention: true } : x)),
            }))
            logEvent(importance === 'info' ? 'done' : 'escalate', id, `Monitor: ${digest.slice(0, 96)}`)
            if (importance === 'critical' && a) notify('escalate', `${a.name} needs attention`, digest.slice(0, 90), id)
            masterEventRef.current(
              `[monitor report · ${importance}] session "${a?.name ?? id}" (${id}): ${digest}\n\n` +
              'This came from the session\'s dedicated monitor. Relay it to the user in 1-2 sentences ending with "Next action:", and act with your tools if needed.',
            )
            return 'reported to Master'
          },
        }
        try {
          await runMonitorTurn(buildCfg(st, st.monitorModel || undefined), agent, current, history, exec)
        } catch (e) {
          logEvent('escalate', id, `Monitor error: ${e instanceof Error ? e.message : String(e)}`)
        }
        pending = monitorQueue.current.get(id)
        monitorQueue.current.delete(id)
      }
    } finally {
      monitorBusy.current.delete(id)
    }
  }, [applyAgentStatus, logEvent, notify, setNeedsInput])

  monitorEventRef.current = (id, note) => runMonitor(id, note)

  const onSettle = useCallback((id: string, since: number) => {
    settleRef.current.delete(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || (agent.status !== 'running' && agent.status !== 'needs')) return
    const st = stateRef.current.settings
    const llm = Boolean(st.masterEnabled && st.apiKey && st.followMode)
    const alt = isAltScreen(id)
    const armed = armedRef.current.get(id)

    // TUIs redraw constantly, so judge the rendered screen (stable) instead
    // of the raw output stream; plain sessions use the new stream tail.
    const streamLines = agent.log.slice(since).map(l => l.x).filter(Boolean)
    const content = alt ? readScreen(id) : streamLines.slice(-14)
    if (!content.length) return
    const lastLine = content[content.length - 1] ?? ''
    const promptDetected = alt
      ? TUI_PROMPT_RE.test(content.join('\n'))
      : PROMPT_RE.test(content.slice(-3).join('\n')) || /[?:]\s*$/.test(lastLine.trim())

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
          )
        }
      }
      return
    }

    // prompt gone — it was answered in the terminal
    if (agent.status === 'needs') {
      lastFlaggedRef.current.delete(id)
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'running' as const, escReason: undefined } : a),
      }))
    }

    if (llm && armed) {
      const joined = content.join('\n')
      const expired = Date.now() - armed.at > 15 * 60 * 1000
      // TUIs pause silently mid-work (API calls) and show a busy marker while
      // generating — don't relay a half-answer, keep checking until stable
      const busy = alt && /esc to interrupt|ctrl\+c to interrupt/i.test(joined)
      const unchanged = joined === armed.snapshot
      if ((busy || unchanged) && !expired) {
        settleRef.current.delete(id)
        const timer = window.setTimeout(() => onSettleRef.current(id, since), 3500)
        settleRef.current.set(id, { since, timer })
        return
      }
      armedRef.current.delete(id)
      if (!expired) {
        void runMonitor(id,
          `The session finished responding. ${alt ? 'Current screen' : 'New output since last check'}:\n${content.slice(-14).join('\n')}\n\n` +
          'It was given a task by Master or the user, so a completed response IS noteworthy — update the status and report a digest to Master.')
      }
    }
  }, [runMonitor, setNeedsInput])

  const onSettleRef = useRef<(id: string, since: number) => void>(() => {})
  onSettleRef.current = onSettle

  // (re)start the settle watcher — checks only run once output goes quiet.
  // Driven by RAW pty activity, because TUI redraws often contain no newlines.
  const bumpSettle = useCallback((id: string) => {
    const prev = settleRef.current.get(id)
    if (prev) window.clearTimeout(prev.timer)
    const since = prev?.since ?? Math.max(0, (stateRef.current.agents.find(a => a.id === id)?.log.length ?? 1) - 1)
    const timer = window.setTimeout(() => onSettle(id, since), 3000)
    settleRef.current.set(id, { since, timer })
  }, [onSettle])
  bumpSettleRef.current = bumpSettle

  // ANSI-stripped tail of each terminal, kept for Master's context, overview
  // cards, and rough usage accounting (the terminal itself renders raw bytes)
  const appendTail = useCallback((id: string, line: string) => {
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => {
        if (a.id !== id) return a
        const log = a.log.concat([{ t: 'out' as const, x: line }])
        if (log.length > 200) log.splice(0, log.length - 200)
        return { ...a, log, used: a.used + 0.01, cost: a.cost + 0.0004 }
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
  const clearNeeds = useCallback((id: string) => {
    lastFlaggedRef.current.delete(id)
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, attention: false, ...(a.status === 'needs' ? { status: 'running' as const, escReason: undefined } : {}) }
        : a),
    }))
  }, [])

  useEffect(() => {
    const offExit = native.onSessionExit(e => {
      const agent = stateRef.current.agents.find(a => a.id === e.id)
      const failed = e.code !== 0 && e.code !== null
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === e.id
          ? {
              ...a,
              status: failed ? 'error' as const : 'idle' as const,
              attention: true,
              log: a.log.concat([{ t: 'sys' as const, x: `process exited${e.code !== null ? ` · code ${e.code}` : ''}` }]),
            }
          : a),
      }))
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
        logEvent(failed ? 'escalate' : 'done', e.id, `${agent.name} ${failed ? `failed · exit ${e.code}` : 'finished'}`)
        notify(
          failed ? 'escalate' : 'done',
          `${agent.name} ${failed ? 'exited with an error' : 'finished'}`,
          failed ? `exit code ${e.code} · ${agent.repo}` : `session ended · ${agent.repo}`,
          e.id,
        )
        void monitorEventRef.current(e.id,
          `The session process ${failed ? `exited with code ${e.code}` : 'finished and exited cleanly'}. Update the status and report a digest to Master.`)
      }
    })
    return () => { offExit() }
  }, [logEvent, notify])


  // persistence: restore everything (including session definitions and their
  // output tails) on launch, save on change. Restored sessions come back
  // paused — resume respawns their command.
  const hydrated = useRef(false)
  const hydrateStarted = useRef(false)
  useEffect(() => {
    if (hydrateStarted.current) return
    hydrateStarted.current = true
    native.loadStateFile().then(json => {
      if (json) {
        try {
          const p = JSON.parse(json) as Partial<PersistedState>
          const restoredAgents: Agent[] = (p.agents ?? [])
            .filter(a => a.kind === 'real' && a.cmd)
            .map(a => ({
              ...a,
              status: 'idle' as const,
              escReason: undefined,
              feed: [], fi: 0,
              log: (a.log ?? []).slice(-200),
            }))
          const ids = new Set(restoredAgents.map(a => a.id))
          const focusedIds = [...new Set((p.focusedIds ?? []).filter(id => ids.has(id)))]
          dispatch(s => ({
            ...s,
            tasks: p.tasks ?? s.tasks,
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
            integrations: p.integrations ?? s.integrations,
            agents: restoredAgents.length ? restoredAgents : s.agents,
            focusedIds: focusedIds.length ? focusedIds : s.focusedIds,
            activePane: Math.min(p.activePane ?? 0, Math.max(0, focusedIds.length - 1)),
            minimizedIds: (p.minimizedIds ?? []).filter(id => ids.has(id)),
            paneSplits: p.paneSplits ?? s.paneSplits,
            addons: p.addons ?? s.addons,
            messages: p.messages?.length ? p.messages : s.messages,
            events: p.events ?? s.events,
            notifications: p.notifications ?? s.notifications,
          }))
          // rebuild each restored session's terminal with its saved tail, and
          // reattach to PTYs that are still alive in the backend (webview reload)
          native.liveSessions().then(liveIds => {
            const alive = new Set(liveIds)
            for (const a of restoredAgents) {
              const { term } = getTerminal(a.id, line => appendTail(a.id, line), () => clearNeeds(a.id), () => bumpSettle(a.id))
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
        } catch { /* corrupt state file — start fresh */ }
      }
      hydrated.current = true
    }).catch(() => { hydrated.current = true })
  }, [appendTail, bumpSettle, clearNeeds])

  const saveTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!hydrated.current) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const persisted: PersistedState = {
      tasks: state.tasks,
      crons: state.crons,
      settings: state.settings,
      toolsCatalog: state.toolsCatalog,
      agentTypes: state.agentTypes,
      integrations: state.integrations,
      agents: state.agents.map(a => ({ ...a, feed: [], log: a.log.slice(-200) })),
      focusedIds: state.focusedIds,
      activePane: state.activePane,
      minimizedIds: state.minimizedIds,
      paneSplits: state.paneSplits,
      addons: state.addons,
      messages: state.messages.slice(-60),
      events: state.events.slice(0, 60),
      notifications: state.notifications.slice(0, 30),
    }
    saveTimer.current = window.setTimeout(() => {
      native.saveStateFile(JSON.stringify(persisted)).catch(() => {})
    }, 800)
  }, [
    state.tasks, state.crons, state.settings, state.toolsCatalog, state.agentTypes, state.integrations,
    state.agents, state.focusedIds, state.activePane, state.minimizedIds, state.paneSplits,
    state.addons, state.messages, state.events, state.notifications,
  ])

  // flush the latest state on quit/reload so nothing inside the debounce window is lost
  useEffect(() => {
    const flush = () => {
      const st = stateRef.current
      const persisted: PersistedState = {
        tasks: st.tasks, crons: st.crons, settings: st.settings,
        toolsCatalog: st.toolsCatalog, agentTypes: st.agentTypes, integrations: st.integrations,
        agents: st.agents.map(a => ({ ...a, feed: [], log: a.log.slice(-200) })),
        focusedIds: st.focusedIds, activePane: st.activePane,
        minimizedIds: st.minimizedIds, paneSplits: st.paneSplits, addons: st.addons,
        messages: st.messages.slice(-60), events: st.events.slice(0, 60),
        notifications: st.notifications.slice(0, 30),
      }
      native.saveStateFile(JSON.stringify(persisted)).catch(() => {})
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // Capture the CLI's own session id (claude/codex) by watching for the
  // session file it creates. Interactive claude ignores --session-id for
  // local persistence, so file detection is the reliable mechanism; after a
  // resume we re-probe because --fork-session (and older CLIs) mint a new id.
  const probeCliSession = useCallback((id: string, command: string, cwd: string, isResume: boolean) => {
    const probeType = typeForCommand(command, stateRef.current.agentTypes)
      ?? typeForCommand(stateRef.current.agents.find(a => a.id === id)?.cmd ?? '', stateRef.current.agentTypes)
    if (!probeType?.probe || !native.isTauri) return
    if (!isResume && /--resume|resume |--continue/.test(command)) return
    const spawnedAt = Date.now()
    const tryDetect = () => {
      const current = stateRef.current.agents.find(a => a.id === id)
      if (!current) return
      if (!isResume && current.cliSessionId) return
      native.detectCliSession(probeType.probe!, cwd || undefined, spawnedAt).then(sid => {
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

  const launchSession = useCallback((command: string, cwd: string, nameHint?: string, typeId?: string): string | null => {
    const trimmed = command.trim()
    if (!trimmed) return null
    const id = mkId('a')
    const bin = trimmed.split(/\s+/)[0].split('/').pop() || trimmed
    const REAL_COLORS = ['#7FD1FF', '#F5C451', '#3DDC97', '#FF9B9B', '#C77DFF', '#E8A87C']
    const color = REAL_COLORS[Math.floor(Math.random() * REAL_COLORS.length)]
    const dir = cwd.trim()
    const agent: Agent = {
      id, name: nameHint || bin, short: (nameHint || bin).slice(0, 2).toUpperCase(), color,
      repo: dir ? dir.split('/').pop() || dir : '~', branch: 'live',
      status: 'running', model: trimmed, kind: 'real', cmd: trimmed, cwd: dir, launchedAt: Date.now(),
      typeId: typeId ?? typeForCommand(trimmed, stateRef.current.agentTypes)?.id,
      fi: 0, feed: [], memory: mkMemory(), tools: mkTools(),
      log: [{ t: 'sys', x: `spawning · ${trimmed}${dir ? ` @ ${dir}` : ''}` }],
      ...defaultDetail(),
    }
    dispatch(s => ({
      ...focusSessionIn({ ...s, agents: s.agents.concat([agent]) }, id),
      newSessionOpen: false,
    }))
    getTerminal(id, line => appendTail(id, line), () => clearNeeds(id), () => bumpSettle(id))
    probeCliSession(id, trimmed, dir, false)
    const launchType = stateRef.current.agentTypes.find(t => t.id === (typeId ?? '')) ?? typeForCommand(trimmed, stateRef.current.agentTypes)
    native.spawnSession(id, `${envPrefix(launchType?.env)}${trimmed}`, dir || undefined).catch(err => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err', x: String(err) }]) }
          : a),
      }))
    })
    return id
  }, [appendTail, bumpSettle, clearNeeds, probeCliSession])

  // Board → session: an unassigned task dragged into work (or explicitly
  // started) spawns the default agent type with the task as its prompt.
  const spawnSessionForTask = useCallback((taskId: string) => {
    const st = stateRef.current
    const task = st.tasks.find(t => t.id === taskId)
    if (!task || task.agentId) return
    const type = st.agentTypes.find(t => t.enabled)
    if (!type) {
      flash('No enabled agent type to handle the task')
      return
    }
    const quoted = `'${task.title.replace(/'/g, `'\\''`)}'`
    const id = launchSession(`${type.model} ${quoted}`, st.settings.defaultCwd || '', task.title.slice(0, 18), type.id)
    if (!id) return
    dispatch(s2 => ({
      ...s2,
      tasks: s2.tasks.map(t => t.id === taskId
        ? { ...t, agentId: id, col: t.col === 'backlog' || t.col === 'done' ? 'progress' as const : t.col }
        : t),
    }))
    armResponseWatch(id)
    logEvent('route', id, `Spawned ${type.name} for task “${task.title.slice(0, 48)}”`)
    flash(`Session spawned for “${task.title.slice(0, 28)}”`)
  }, [armResponseWatch, flash, launchSession, logEvent])

  // cron scheduler: fire enabled schedules once per matching minute
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = new Date()
      const minuteKey = now.toISOString().slice(0, 16)
      const due = stateRef.current.crons.filter(c =>
        c.on && c.lastFiredMinute !== minuteKey && cronMatches(c.schedule, now))
      if (!due.length) return
      const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      dispatch(s => ({
        ...s,
        crons: s.crons.map(c => due.some(d => d.id === c.id)
          ? { ...c, lastFiredMinute: minuteKey, last: `ran · ${timeLabel}` }
          : c),
      }))
      due.forEach(c => {
        logEvent('cron', null, `${c.name} fired${c.cmd ? ` · launching ${c.cmd}` : ''}`)
        notify('cron', `${c.name} fired`, c.cmd ? `launched: ${c.cmd}` : 'schedule ran', null)
        if (c.cmd && native.isTauri) launchSession(c.cmd, c.cwd || '', c.name)
      })
    }, 15000)
    return () => window.clearInterval(timer)
  }, [launchSession, logEvent, notify])

  // Master brain: run one LLM turn (chat → tools → chat), serializing turns
  const masterBusyRef = useRef(false)
  const masterQueued = useRef<{ note?: string } | null>(null)

  const lastEventRef = useRef<{ note: string; at: number } | null>(null)

  const runMaster = useCallback(async (eventNote?: string) => {
    if (!stateRef.current.settings.apiKey) return
    if (eventNote) {
      const last = lastEventRef.current
      if (last && last.note === eventNote && Date.now() - last.at < 10000) return
      lastEventRef.current = { note: eventNote, at: Date.now() }
    }
    if (masterBusyRef.current) {
      masterQueued.current = { note: eventNote ?? masterQueued.current?.note }
      return
    }
    masterBusyRef.current = true
    dispatch(s => ({ ...s, masterBusy: true }))

    // permission gates: global Tools registry + per-session overrides
    const catalogGate = (toolId: string): string | null => {
      const perm = stateRef.current.toolsCatalog.find(t => t.id === toolId)?.perm ?? 'Auto'
      if (perm === 'Off') return `blocked: the user disabled "${toolId}" in the Tools registry`
      if (perm === 'Approval') return `blocked: "${toolId}" is set to Approval — ask the user to change it in Tools`
      return null
    }
    const sessionGate = (sid: string, toolId: string): string | null => {
      const agent = stateRef.current.agents.find(a => a.id === sid)
      const tool = agent?.tools.find(t => t.id === toolId)
      if (!tool) return null
      if (!tool.on || tool.perm === 'Off') return `blocked: the user disabled "${toolId}" for this session`
      if (tool.perm === 'Approval') return `blocked: "${toolId}" for this session is set to Approval — ask the user`
      return null
    }

    const exec: MasterExec = {
      launchSession: (command, cwd, name) => {
        const gated = catalogGate('launch_session')
        if (gated) return gated
        const id = launchSession(command, cwd || '', name)
        if (!id) return 'failed: empty command'
        logEvent('route', id, `Master launched · ${command}`)
        armResponseWatch(id) // relay the session's first output back to Master
        return `launched session id=${id} — its output will be relayed to you as an [event] once it settles; you can also read_session it`
      },
      sendToSession: async (sid, text) => {
        const gated = catalogGate('send_to_session') || sessionGate(sid, 'send')
        if (gated) return gated
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        armResponseWatch(sid)
        sendLineToSession(sid, text)
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === sid ? { ...a, log: a.log.concat([{ t: 'you', x: `[master] ${text}` }]) } : a),
        }))
        logEvent('route', sid, `Master → ${agent.name}: ${text.slice(0, 48)}`)
        await wait(1600)
        return `sent to ${agent.name}. screen now:\n${sessionScreenTail(sid)}`
      },
      pressKeys: async (sid, keys) => {
        const gated = catalogGate('send_to_session') || sessionGate(sid, 'send')
        if (gated) return gated
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        if (!keys.length) return 'no keys given'
        for (const key of keys.slice(0, 12)) {
          const seq = KEYMAP[key.toLowerCase()] ?? (key.length === 1 ? key : null)
          if (seq === null) return `unknown key "${key}" — use enter/esc/up/down/left/right/tab/space/backspace/ctrl+c or single characters`
          native.writeSession(sid, seq).catch(() => {})
          await wait(160)
        }
        logEvent('route', sid, `Master pressed ${keys.join(' ')} in ${agent.name}`)
        armResponseWatch(sid)
        await wait(900)
        return `pressed ${keys.join(' ')}. screen now:\n${sessionScreenTail(sid)}`
      },
      configureSetting: (key, value) => {
        const gated = catalogGate('configure_setting')
        if (gated) return gated
        const bools = ['autoRoute', 'approveDestructive', 'followMode'] as const
        const strings = ['shell', 'defaultCwd', 'masterModel'] as const
        if ((bools as readonly string[]).includes(key)) {
          const v = value.toLowerCase() === 'true'
          dispatch(s2 => ({ ...s2, settings: { ...s2.settings, [key]: v } }))
          logEvent('edit', null, `Master set ${key} = ${v}`)
          return `set ${key} = ${v}`
        }
        if ((strings as readonly string[]).includes(key)) {
          dispatch(s2 => ({ ...s2, settings: { ...s2.settings, [key]: value } }))
          logEvent('edit', null, `Master set ${key} = ${value}`)
          return `set ${key} = ${value}`
        }
        return `unknown or protected setting: ${key}`
      },
      setToolPermission: (toolId, perm) => {
        const gated = catalogGate('set_tool_permission')
        if (gated) return gated
        if (!(PERM_ORDER as readonly string[]).includes(perm)) return `invalid perm "${perm}" — use Off | Ask first | Auto | Approval`
        const tool = stateRef.current.toolsCatalog.find(t => t.id === toolId)
        if (!tool) return `no tool with id ${toolId}`
        dispatch(s2 => ({
          ...s2,
          toolsCatalog: s2.toolsCatalog.map(t => (t.id === toolId ? { ...t, perm: perm as typeof t.perm } : t)),
        }))
        logEvent('edit', null, `Master set ${toolId} permission to ${perm}`)
        return `set ${toolId} to ${perm}`
      },
      toggleSchedule: (name, on) => {
        const cron = stateRef.current.crons.find(c => c.name === name)
        if (!cron) return `no schedule named ${name}`
        dispatch(s2 => ({ ...s2, crons: s2.crons.map(c => (c.name === name ? { ...c, on } : c)) }))
        return `${name} is now ${on ? 'on' : 'off'}`
      },
      deleteSchedule: name => {
        const cron = stateRef.current.crons.find(c => c.name === name)
        if (!cron) return `no schedule named ${name}`
        dispatch(s2 => ({ ...s2, crons: s2.crons.filter(c => c.name !== name) }))
        logEvent('cron', null, `Master deleted schedule ${name}`)
        return `deleted ${name}`
      },
      createAddon: (name, icon, html, desc) => {
        const gated = catalogGate('create_addon')
        if (gated) return gated
        if (!name.trim() || !html.trim()) return 'name and html are required'
        const existing = stateRef.current.addons.find(a => a.name === name)
        const addon: Addon = {
          id: existing?.id ?? mkId('ad'),
          name: name.trim(),
          icon: (icon || '◆').slice(0, 2),
          html,
          desc,
          createdAt: new Date().toLocaleString(),
        }
        dispatch(s2 => ({
          ...s2,
          addons: existing
            ? s2.addons.map(a => (a.id === existing.id ? addon : a))
            : s2.addons.concat([addon]),
          view: 'addon',
          activeAddon: addon.id,
        }))
        logEvent('build', null, `Master ${existing ? 'updated' : 'built'} addon “${name}”`)
        flash(`${existing ? 'Updated' : 'New'} addon · ${name}`)
        return `${existing ? 'updated' : 'created'} addon "${name}" — it is open now as a tab in the icon rail`
      },
      removeAddon: name => {
        const addon = stateRef.current.addons.find(a => a.name === name)
        if (!addon) return `no addon named ${name}`
        dispatch(s2 => ({
          ...s2,
          addons: s2.addons.filter(a => a.id !== addon.id),
          view: s2.activeAddon === addon.id ? 'workspace' : s2.view,
          activeAddon: s2.activeAddon === addon.id ? null : s2.activeAddon,
        }))
        return `removed addon "${name}"`
      },
      updateAgentStatus: (sid, task, summary, actionNeeded) => {
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        applyAgentStatus(sid, task, summary, actionNeeded)
        return `updated status for ${agent.name}`
      },
      renameSession: (sid, name) => {
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        const trimmed = name.trim()
        if (!trimmed) return 'name must not be empty'
        dispatch(s2 => ({
          ...s2,
          agents: s2.agents.map(a => a.id === sid
            ? { ...a, name: trimmed, short: trimmed.slice(0, 2).toUpperCase() }
            : a),
        }))
        logEvent('edit', sid, `Master renamed session to “${trimmed}”`)
        return `renamed to ${trimmed}`
      },
      flagNeedsInput: (sid, question) => {
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        setNeedsInput(sid, question || 'waiting for input')
        return `flagged ${agent.name} as needing user input`
      },
      readSession: (sid, lines) => {
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        const n = Math.min(Math.max(lines ?? 40, 1), 120)
        const tail = agent.log.slice(-n).map(l => l.x).join('\n')
        return tail || '(no output yet)'
      },
      stopSession: sid => {
        const gated = catalogGate('stop_session') || sessionGate(sid, 'stop')
        if (gated) return gated
        native.killSession(sid).catch(() => {})
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === sid ? { ...a, status: 'idle' as const } : a),
        }))
        return `stopped ${sid}`
      },
      createSchedule: (name, cron, command, cwd) => {
        const gated = catalogGate('create_schedule')
        if (gated) return gated
        dispatch(s => ({
          ...s,
          crons: s.crons.concat([{
            id: mkId('c'), name, schedule: cron, human: humanizeCron(cron),
            target: cwd ? cwd.split('/').pop() || cwd : 'workspace',
            agent: command ? command.split(/\s+/)[0] : 'Master',
            color: '#F5C451', on: true, built: true, last: '—', cmd: command, cwd,
          }]),
        }))
        logEvent('cron', null, `Master created schedule ${name}`)
        return `created schedule ${name} (${cron})`
      },
      addTask: title => {
        const gated = catalogGate('add_task')
        if (gated) return gated
        dispatch(s => ({
          ...s,
          tasks: s.tasks.concat([{ id: mkId('t'), title, col: 'backlog', agentId: null }]),
        }))
        return `added task "${title}"`
      },
    }

    let pendingTurn: { note?: string } | null = { note: eventNote }
    while (pendingTurn) {
      const note = pendingTurn.note
      pendingTurn = null
      try {
        const { text, thinking } = await runMasterTurn(() => stateRef.current, exec, note)
        if (text || thinking) {
          dispatch(s => ({
            ...s,
            messages: s.messages.concat([{
              id: mkId('m'), role: 'master', kind: 'text',
              text: text || '(acted without a reply)',
              thinking: thinking || undefined,
            }]),
          }))
        }
      } catch (e) {
        dispatch(s => ({
          ...s,
          messages: s.messages.concat([{
            id: mkId('m'), role: 'master', kind: 'text',
            text: `Master error: ${e instanceof Error ? e.message : String(e)}`,
          }]),
        }))
      }
      pendingTurn = masterQueued.current
      masterQueued.current = null
    }

    masterBusyRef.current = false
    dispatch(s => ({ ...s, masterBusy: false }))
  }, [applyAgentStatus, armResponseWatch, flash, launchSession, logEvent, sessionScreenTail, setNeedsInput])

  masterEventRef.current = note => { void runMaster(note) }

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
      if (st.apiKey && st.masterEnabled) {
        later(50, () => { void runMaster() })
      } else {
        later(300, () => dispatch(s2 => ({
          ...s2,
          messages: s2.messages.concat([{
            id: mkId('m'), role: 'master', kind: 'text',
            text: s2.settings.apiKey
              ? 'My brain is switched off — enable “LLM Master” in Settings → Master Brain and I’ll take it from there.'
              : 'I need a brain first: add your Anthropic API key in Settings → Master Brain (and flip the LLM Master toggle), then ask me again.',
          }]),
        })))
      }
    },

    focusComposer: () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-composer]')
      el?.focus()
    },

    setActivePane: i => dispatch(s => {
      const id = s.focusedIds[i]
      return {
        ...s,
        activePane: i,
        agents: id ? s.agents.map(a => (a.id === id ? { ...a, attention: false } : a)) : s.agents,
      }
    }),

    focusTab: id => dispatch(s => focusSessionIn(s, id)),

    addPane: () => dispatch(s => {
      if (s.focusedIds.length >= 6) return s
      const hidden = s.agents.find(a => !a.archived && !s.focusedIds.includes(a.id))
      if (!hidden) return { ...s, newSessionOpen: true, view: 'workspace' }
      const focusedIds = s.focusedIds.concat([hidden.id])
      return { ...s, focusedIds, activePane: focusedIds.length - 1, maximizedPane: null, view: 'workspace' }
    }),

    closePane: i => dispatch(s => {
      if (s.focusedIds.length <= 1) return s
      const focusedIds = s.focusedIds.slice()
      focusedIds.splice(i, 1)
      return {
        ...s,
        focusedIds,
        activePane: Math.min(s.activePane, focusedIds.length - 1),
        maximizedPane: null,
      }
    }),

    toggleMaximize: i => dispatch(s => ({
      ...s,
      maximizedPane: s.maximizedPane === i ? null : i,
      activePane: i,
    })),

    minimizePane: i => dispatch(s => {
      const id = s.focusedIds[i]
      if (!id) return s
      const focusedIds = s.focusedIds.slice()
      focusedIds.splice(i, 1)
      return {
        ...s,
        focusedIds,
        minimizedIds: s.minimizedIds.includes(id) ? s.minimizedIds : s.minimizedIds.concat([id]),
        activePane: Math.max(0, Math.min(s.activePane, focusedIds.length - 1)),
        maximizedPane: null,
      }
    }),

    restoreSession: id => dispatch(s => {
      // restoring from the dock opens a split if there's room (it was
      // deliberately parked, not swapped away)
      if (!s.focusedIds.includes(id) && s.focusedIds.length < 6) {
        const focusedIds = s.focusedIds.concat([id])
        return {
          ...s, focusedIds,
          minimizedIds: s.minimizedIds.filter(x => x !== id),
          activePane: focusedIds.length - 1, view: 'workspace', maximizedPane: null,
        }
      }
      return focusSessionIn(s, id)
    }),

    setRowSplit: v => dispatch(s => ({ ...s, paneSplits: { ...s.paneSplits, row: v } })),
    setColSplit: (row, v) => dispatch(s => {
      const cols = s.paneSplits.cols.slice()
      cols[row] = v
      return { ...s, paneSplits: { ...s.paneSplits, cols } }
    }),

    renameSession: (id, name) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, name: name.trim() || a.name, short: (name.trim() || a.name).slice(0, 2).toUpperCase() }
        : a),
    })),

    archiveSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.status === 'running' || agent?.status === 'needs') native.killSession(id).catch(() => {})
      dispatch(s => {
        const focusedIds = s.focusedIds.filter(x => x !== id)
        return {
          ...s,
          agents: s.agents.map(a => a.id === id ? { ...a, archived: true, status: 'idle' as const, escReason: undefined } : a),
          focusedIds,
          minimizedIds: s.minimizedIds.filter(x => x !== id),
          activePane: Math.max(0, Math.min(s.activePane, focusedIds.length - 1)),
          maximizedPane: null,
          drawer: s.drawer?.agentId === id ? null : s.drawer,
        }
      })
      flash(`Archived ${agent?.name ?? 'session'}`)
      logEvent('edit', id, `Archived session ${agent?.name ?? id}`)
    },

    unarchiveSession: id => dispatch(s => focusSessionIn(s, id)),

    deleteSession: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      native.killSession(id).catch(() => {})
      disposeTerminal(id)
      monitorHistories.current.delete(id)
      dispatch(s => {
        const focusedIds = s.focusedIds.filter(x => x !== id)
        return {
          ...s,
          agents: s.agents.filter(a => a.id !== id),
          tasks: s.tasks.map(t => (t.agentId === id ? { ...t, agentId: null } : t)),
          focusedIds,
          minimizedIds: s.minimizedIds.filter(x => x !== id),
          activePane: Math.max(0, Math.min(s.activePane, focusedIds.length - 1)),
          maximizedPane: null,
          drawer: s.drawer?.agentId === id ? null : s.drawer,
          panel: s.panel?.agentId === id ? null : s.panel,
        }
      })
      flash(`Deleted ${agent?.name ?? 'session'}`)
      logEvent('edit', null, `Deleted session ${agent?.name ?? id}`)
    },

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
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
        spawnAgentProcess(id, `${envPrefix(type?.env)}${cmd}`, agent.cwd).catch(() => {})
        probeCliSession(id, cmd, agent.cwd || '', true)
      }
      dispatch(s => focusSessionIn({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'running' as const, log: a.log.concat([{ t: 'sys', x: resumeNote }]) }
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
      const needsAgent = s.agents.find(a => a.status === 'needs' || a.status === 'error')
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

    toggleIntegration: id => dispatch(s => ({
      ...s,
      integrations: s.integrations.map(x => x.id === id
        ? { ...x, connected: !x.connected, detail: !x.connected ? 'connected just now' : 'not connected' }
        : x),
    })),

    toggleAgentType: id => dispatch(s => ({
      ...s,
      agentTypes: s.agentTypes.map(x => (x.id === id ? { ...x, enabled: !x.enabled } : x)),
    })),

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
      dispatch(s => id
        ? { ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, col } : t)), dragOverCol: null }
        : { ...s, dragOverCol: null })
      if (id && (col === 'routed' || col === 'progress')) {
        const task = stateRef.current.tasks.find(t => t.id === id)
        if (task && !task.agentId) later(50, () => spawnSessionForTask(id))
      }
    },

    startTask: taskId => spawnSessionForTask(taskId),
    addTask: () => dispatch(s => ({
      ...s,
      tasks: s.tasks.concat([{ id: mkId('t'), title: 'New task', col: 'backlog', agentId: null }]),
    })),
    renameTask: (id, title) => dispatch(s => ({
      ...s,
      tasks: s.tasks.map(t => (t.id === id ? { ...t, title: title.trim() || t.title } : t)),
    })),
    deleteTask: id => dispatch(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== id) })),

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
    removeAddon: id => dispatch(s => ({
      ...s,
      addons: s.addons.filter(a => a.id !== id),
      view: s.activeAddon === id ? 'workspace' : s.view,
      activeAddon: s.activeAddon === id ? null : s.activeAddon,
    })),

    openNewSession: () => dispatch(s => ({ ...s, newSessionOpen: true })),
    closeNewSession: () => dispatch(s => ({ ...s, newSessionOpen: false })),

    newRealSession: (command, cwd) => {
      const id = launchSession(command, cwd)
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
      native.killSession(id).catch(() => {})
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'idle' as const, log: a.log.concat([{ t: 'sys', x: 'stopped by you' }]) }
          : a),
      }))
      flash('Session stopped')
    },
  }), [armResponseWatch, flash, later, launchSession, logEvent, probeCliSession, runMaster, spawnSessionForTask])

  // ⌘K / Ctrl+K toggles the command palette; Escape closes overlays
  useEffect(() => {
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
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  )
}

export function useConductor(): AppState {
  const s = useContext(StateCtx)
  if (!s) throw new Error('useConductor outside provider')
  return s
}

export function useActions(): ConductorActions {
  const a = useContext(ActionsCtx)
  if (!a) throw new Error('useActions outside provider')
  return a
}

export type { LogLine }
