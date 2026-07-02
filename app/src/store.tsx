/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  Agent, AppState, BoardCol, Cron, EventType, LogLine,
  NotifKind, Notification, Panel, PersistedState, View,
} from './types'
import { defaultDetail, mkMemory, mkTools, PERM_ORDER, seedState } from './data'
import * as native from './native'
import { runMasterTurn } from './master'
import type { MasterExec } from './master'
import { getTerminal, isAltScreen } from './terminals'

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
  renameSession: (id: string, name: string) => void
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
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  addTask: () => void
  renameTask: (id: string, title: string) => void
  deleteTask: (id: string) => void
  addCron: (cron: Omit<Cron, 'id' | 'on' | 'built' | 'last'>) => void
  deleteCron: (id: string) => void
  openNewSession: () => void
  closeNewSession: () => void
  newRealSession: (command: string, cwd: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}

const StateCtx = createContext<AppState | null>(null)
const ActionsCtx = createContext<ConductorActions | null>(null)

let uid = 0
function mkId(prefix: string): string {
  uid += 1
  return `${prefix}${Date.now()}-${uid}`
}

// Matches one field of a five-field cron expression: *, */n, a, a-b, and comma lists.
function fieldMatches(field: string, value: number): boolean {
  return field.split(',').some(part => {
    if (part === '*') return true
    const step = part.match(/^\*\/(\d+)$/)
    if (step) return value % parseInt(step[1], 10) === 0
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) return value >= parseInt(range[1], 10) && value <= parseInt(range[2], 10)
    return parseInt(part, 10) === value
  })
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, mon, dow] = fields
  return (
    fieldMatches(min, d.getMinutes()) &&
    fieldMatches(hour, d.getHours()) &&
    fieldMatches(dom, d.getDate()) &&
    fieldMatches(mon, d.getMonth() + 1) &&
    fieldMatches(dow, d.getDay())
  )
}

export function humanizeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hour, , , dow] = f
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dow === '*') return `Every day · ${time}`
    if (/^\d+$/.test(dow)) return `${DAYS[parseInt(dow, 10) % 7]}s · ${time}`
  }
  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`
  return expr
}

// Heuristics for "this CLI is waiting on the user": y/n prompts, permission
// questions, confirmation menus.
const PROMPT_RE = /(\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|yes\/no|do you want|would you like|allow this|allow .*\?|permission|approve\?|confirm|proceed\?|continue\?|password:|are you sure|press enter to|\(esc to cancel\))/i

function spawnAgentProcess(id: string, command: string, cwd?: string): Promise<void> {
  return native.spawnSession(id, command.trim(), cwd || undefined)
}

export function ConductorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, seedState)
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

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
  const armedRef = useRef<Set<string>>(new Set())
  const settleRef = useRef<Map<string, { since: number; timer: number }>>(new Map())
  const lastUnarmedEventRef = useRef<Map<string, number>>(new Map())

  const armResponseWatch = useCallback((id: string) => {
    armedRef.current.add(id)
  }, [])

  const setNeedsInput = useCallback((id: string, question: string) => {
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || agent.status !== 'running') return
    dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id ? { ...a, status: 'needs' as const, escReason: question } : a),
      messages: s.messages.concat([{
        id: mkId('m'), role: 'master', kind: 'escalate', escFor: id,
        esc: { name: agent.name, color: agent.color, repo: agent.repo, reason: question, resolved: false, decision: null },
      }]),
    }))
    logEvent('escalate', id, `${agent.name} is asking for input: ${question.slice(0, 64)}`)
    notify('escalate', `${agent.name} needs your input`, question.slice(0, 80), id)
  }, [logEvent, notify])

  const onSettle = useCallback((id: string, since: number) => {
    settleRef.current.delete(id)
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (!agent || (agent.status !== 'running' && agent.status !== 'needs')) return
    const lines = agent.log.slice(since).map(l => l.x).filter(Boolean)
    if (!lines.length) return
    const tail = lines.slice(-14)
    const lastLine = tail[tail.length - 1] ?? ''
    const alt = isAltScreen(id)
    // TUI redraws (alternate screen) look like new output — never apply the
    // prompt heuristic to them, and only involve Master when it asked (armed)
    const promptLike = !alt && (PROMPT_RE.test(tail.slice(-3).join('\n')) || /[?:]\s*$/.test(lastLine.trim()))
    const st = stateRef.current.settings
    const armed = armedRef.current.has(id)

    if (st.masterEnabled && st.apiKey && st.followMode) {
      const last = lastUnarmedEventRef.current.get(id) ?? 0
      const throttled = !armed && Date.now() - last < 30000
      if ((armed || promptLike) && !throttled) {
        if (!armed) lastUnarmedEventRef.current.set(id, Date.now())
        armedRef.current.delete(id)
        masterEventRef.current(
          `[event] session "${agent.name}" (${id}) stopped producing output. New output since last check:\n${tail.join('\n')}\n\n` +
          'If this session is waiting for user input or permission, call flag_needs_input with what it is asking. ' +
          'Otherwise briefly relay the outcome if meaningful; if there is nothing worth telling the user, reply with an empty message.',
        )
      }
    } else if (agent.status === 'running' && promptLike) {
      setNeedsInput(id, lastLine)
    } else if (agent.status === 'needs' && !promptLike && !alt) {
      // prompt is gone — it was answered in the terminal
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'running' as const, escReason: undefined } : a),
      }))
    }
  }, [setNeedsInput])

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
    // (re)start the settle watcher — checks only run once output goes quiet
    const prev = settleRef.current.get(id)
    if (prev) window.clearTimeout(prev.timer)
    const since = prev?.since ?? Math.max(0, (stateRef.current.agents.find(a => a.id === id)?.log.length ?? 1) - 1)
    const timer = window.setTimeout(() => onSettle(id, since), 3000)
    settleRef.current.set(id, { since, timer })
  }, [onSettle])

  // typing into a terminal clears its "needs action" state
  const clearNeeds = useCallback((id: string) => {
    const agent = stateRef.current.agents.find(a => a.id === id)
    if (agent?.status === 'needs') {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id ? { ...a, status: 'running' as const, escReason: undefined } : a),
      }))
    }
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
              log: a.log.concat([{ t: 'sys' as const, x: `process exited${e.code !== null ? ` · code ${e.code}` : ''}` }]),
            }
          : a),
      }))
      if (agent) {
        logEvent(failed ? 'escalate' : 'done', e.id, `${agent.name} ${failed ? `failed · exit ${e.code}` : 'finished'}`)
        notify(
          failed ? 'escalate' : 'done',
          `${agent.name} ${failed ? 'exited with an error' : 'finished'}`,
          failed ? `exit code ${e.code} · ${agent.repo}` : `session ended · ${agent.repo}`,
          e.id,
        )
        if (stateRef.current.settings.masterEnabled && stateRef.current.settings.apiKey && stateRef.current.settings.followMode) {
          masterEventRef.current(`[event] session "${agent.name}" (${e.id}) ${failed ? `exited with code ${e.code}` : 'finished'}. Tell the user, and suggest a next step if useful.`)
        }
      }
    })
    return () => { offExit() }
  }, [logEvent, notify])

  // set by the Master turn runner below; ref avoids a declaration cycle
  const masterEventRef = useRef<(note: string) => void>(() => {})

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
          const focusedIds = (p.focusedIds ?? []).filter(id => ids.has(id))
          dispatch(s => ({
            ...s,
            tasks: p.tasks ?? s.tasks,
            crons: p.crons ?? s.crons,
            settings: { ...s.settings, ...(p.settings || {}) },
            toolsCatalog: p.toolsCatalog?.some(t => t.id === 'launch_session') ? p.toolsCatalog : s.toolsCatalog,
            agentTypes: p.agentTypes ?? s.agentTypes,
            integrations: p.integrations ?? s.integrations,
            agents: restoredAgents.length ? restoredAgents : s.agents,
            focusedIds: focusedIds.length ? focusedIds : s.focusedIds,
            activePane: Math.min(p.activePane ?? 0, Math.max(0, focusedIds.length - 1)),
            messages: p.messages?.length ? p.messages : s.messages,
            events: p.events ?? s.events,
            notifications: p.notifications ?? s.notifications,
          }))
          // rebuild each restored session's terminal with its saved tail, and
          // reattach to PTYs that are still alive in the backend (webview reload)
          native.liveSessions().then(liveIds => {
            const alive = new Set(liveIds)
            for (const a of restoredAgents) {
              const { term } = getTerminal(a.id, line => appendTail(a.id, line), () => clearNeeds(a.id))
              for (const l of a.log) term.writeln(`\x1b[90m${l.x}\x1b[0m`)
              term.writeln(alive.has(a.id)
                ? '\x1b[32m── reattached · session is still running ──\x1b[0m'
                : '\x1b[33m── restored from previous run · press ▶ to relaunch ──\x1b[0m')
            }
            if (alive.size) {
              dispatch(s2 => ({
                ...s2,
                agents: s2.agents.map(a => alive.has(a.id) ? { ...a, status: 'running' as const } : a),
              }))
            }
          }).catch(() => {})
        } catch { /* corrupt state file — start fresh */ }
      }
      hydrated.current = true
    }).catch(() => { hydrated.current = true })
  }, [appendTail, clearNeeds])

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
      messages: state.messages.slice(-60),
      events: state.events.slice(0, 60),
      notifications: state.notifications.slice(0, 30),
    }
    saveTimer.current = window.setTimeout(() => {
      native.saveStateFile(JSON.stringify(persisted)).catch(() => {})
    }, 800)
  }, [
    state.tasks, state.crons, state.settings, state.toolsCatalog, state.agentTypes, state.integrations,
    state.agents, state.focusedIds, state.activePane, state.messages, state.events, state.notifications,
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
        messages: st.messages.slice(-60), events: st.events.slice(0, 60),
        notifications: st.notifications.slice(0, 30),
      }
      native.saveStateFile(JSON.stringify(persisted)).catch(() => {})
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const launchSession = useCallback((command: string, cwd: string, nameHint?: string): string | null => {
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
      status: 'running', model: trimmed, kind: 'real', cmd: trimmed, cwd: dir,
      fi: 0, feed: [], memory: mkMemory(), tools: mkTools(),
      log: [{ t: 'sys', x: `spawning · ${trimmed}${dir ? ` @ ${dir}` : ''}` }],
      ...defaultDetail(),
    }
    dispatch(s => {
      // a new terminal gets its own pane while there's room in the grid
      const focusedIds = s.focusedIds.slice()
      let activePane: number
      if (focusedIds.length < 4) {
        focusedIds.push(id)
        activePane = focusedIds.length - 1
      } else {
        activePane = s.activePane
        focusedIds[activePane] = id
      }
      return {
        ...s, agents: s.agents.concat([agent]), focusedIds, activePane,
        maximizedPane: null, view: 'workspace', newSessionOpen: false,
      }
    })
    getTerminal(id, line => appendTail(id, line), () => clearNeeds(id))
    native.spawnSession(id, trimmed, dir || undefined).catch(err => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err', x: String(err) }]) }
          : a),
      }))
    })
    return id
  }, [appendTail, clearNeeds])

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

  const runMaster = useCallback(async (eventNote?: string) => {
    if (!stateRef.current.settings.apiKey) return
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
      sendToSession: (sid, text) => {
        const gated = catalogGate('send_to_session') || sessionGate(sid, 'send')
        if (gated) return gated
        const agent = stateRef.current.agents.find(a => a.id === sid)
        if (!agent) return `no session with id ${sid}`
        armResponseWatch(sid)
        native.writeSession(sid, `${text}\r`).catch(() => {})
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === sid ? { ...a, log: a.log.concat([{ t: 'you', x: `[master] ${text}` }]) } : a),
        }))
        logEvent('route', sid, `Master → ${agent.name}: ${text.slice(0, 48)}`)
        return `sent to ${agent.name}`
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
        const text = await runMasterTurn(() => stateRef.current, exec, note)
        if (text) {
          dispatch(s => ({ ...s, messages: s.messages.concat([{ id: mkId('m'), role: 'master', kind: 'text', text }]) }))
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
  }, [armResponseWatch, launchSession, logEvent, setNeedsInput])

  masterEventRef.current = note => { void runMaster(note) }

  const actions = useMemo<ConductorActions>(() => ({
    setView: v => dispatch(s => ({ ...s, view: v })),
    setComposer: v => dispatch(s => ({ ...s, composer: v })),

    send: () => {
      dispatch(s => {
        const text = s.composer.trim()
        if (!text) return s
        if (s.settings.apiKey && s.settings.masterEnabled) {
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
        return { ...s, messages: s.messages.concat([{ id: mkId('u'), role: 'you', kind: 'text', text }]), composer: '' }
      })
    },

    focusComposer: () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-composer]')
      el?.focus()
    },

    setActivePane: i => dispatch(s => ({ ...s, activePane: i })),

    focusTab: id => dispatch(s => {
      const existing = s.focusedIds.indexOf(id)
      if (existing >= 0) return { ...s, activePane: existing, view: 'workspace', maximizedPane: s.maximizedPane === null ? null : existing }
      const focusedIds = s.focusedIds.slice()
      focusedIds[Math.min(s.activePane, Math.max(0, focusedIds.length - 1))] = id
      if (!focusedIds.length) focusedIds.push(id)
      return { ...s, focusedIds, view: 'workspace' }
    }),

    addPane: () => dispatch(s => {
      if (s.focusedIds.length >= 6) return s
      const hidden = s.agents.find(a => !s.focusedIds.includes(a.id))
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

    renameSession: (id, name) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, name: name.trim() || a.name, short: (name.trim() || a.name).slice(0, 2).toUpperCase() }
        : a),
    })),

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.kind === 'real' && agent.cmd && agent.status !== 'running') {
        spawnAgentProcess(id, agent.cmd, agent.cwd).catch(() => {})
      }
      dispatch(s => {
        const focusedIds = s.focusedIds.slice()
        focusedIds[s.activePane] = id
        return {
          ...s,
          agents: s.agents.map(a => a.id === id
            ? { ...a, status: 'running' as const, log: a.log.concat([{ t: 'sys', x: 'session resumed' }]) }
            : a),
          focusedIds, view: 'workspace',
        }
      })
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
      if (!needsAgent) return s
      const focusedIds = s.focusedIds.slice()
      focusedIds[s.activePane] = needsAgent.id
      return { ...s, focusedIds, view: 'workspace' }
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
        const focusedIds = next.focusedIds.slice()
        focusedIds[next.activePane] = n.agentId
        return { ...next, focusedIds, view: 'workspace' }
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

    startCardDrag: id => { dragId.current = id },
    enterCol: col => dispatch(s => (s.dragOverCol === col ? s : { ...s, dragOverCol: col })),
    dropTo: col => {
      const id = dragId.current
      dragId.current = null
      dispatch(s => id
        ? { ...s, tasks: s.tasks.map(t => (t.id === id ? { ...t, col } : t)), dragOverCol: null }
        : { ...s, dragOverCol: null })
    },
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
      native.writeSession(id, `${text}\r`).catch(err => {
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === id
            ? { ...a, log: a.log.concat([{ t: 'err', x: String(err) }]) }
            : a),
        }))
      })
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
  }), [armResponseWatch, flash, later, launchSession, logEvent, runMaster])

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
