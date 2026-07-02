/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'
import type { Agent, AppState, BoardCol, Cron, CatalogTool, EventType, LogLine, Message, Notification, Panel, PersistedState, View } from './types'
import { AIDER_APPROVE_FEED, CLAUDE_FEED, PERM_ORDER, defaultDetail, mkMemory, mkTools, seedState } from './data'
import * as native from './native'

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
  toggleSplit: () => void
  closePane: (i: number) => void
  newSession: () => void
  resume: (id: string) => void
  openPanel: (id: string, tab?: Panel['tab']) => void
  setPanelTab: (tab: Panel['tab']) => void
  closePanel: () => void
  toggleMem: (aid: string, mid: string) => void
  toggleTool: (aid: string, tid: string) => void
  cyclePerm: (aid: string, tid: string) => void
  toggleCron: (id: string) => void
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
  startCardDrag: (id: string) => void
  enterCol: (col: BoardCol) => void
  dropTo: (col: BoardCol) => void
  addTask: () => void
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

function classify(text: string): 'build' | 'ask' | 'route' {
  const t = text.toLowerCase().trim()
  if (
    /\b(build|create|make|set up|scaffold|generate)\b.*\b(tool|integration|mcp|cron|schedule|job|panel|dashboard|view|ui|report)\b/.test(t) ||
    /\b(nightly|every day|every week|weekly|daily|hourly|each morning)\b/.test(t)
  ) return 'build'
  if (/\?\s*$/.test(text) || /^(what|which|how|why|when|who|where|is|are|do|does|can|status|show me|list|tell me|any )\b/.test(t)) return 'ask'
  return 'route'
}

export function ConductorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, seedState)
  const toastTimer = useRef<number | undefined>(undefined)
  const pending = useRef<number[]>([])
  const dragId = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  // live streaming tick: running agents replay their feed
  useEffect(() => {
    const timer = window.setInterval(() => {
      dispatch(s => {
        if (s.paletteOpen) return s
        return {
          ...s,
          agents: s.agents.map(a => {
            if (a.status !== 'running' || !a.feed.length) return a
            const line = a.feed[a.fi % a.feed.length]
            const log = a.log.concat([line])
            if (log.length > 70) log.splice(0, log.length - 70)
            return { ...a, log, fi: a.fi + 1 }
          }),
        }
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timers = pending.current
    return () => {
      timers.forEach(t => window.clearTimeout(t))
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  // stream real session output/exit events into agent logs
  useEffect(() => {
    const appendLog = (id: string, line: LogLine, status?: Agent['status']) =>
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => {
          if (a.id !== id) return a
          const log = a.log.concat([line])
          if (log.length > 500) log.splice(0, log.length - 500)
          return { ...a, log, ...(status ? { status } : {}) }
        }),
      }))
    const offOut = native.onSessionOutput(e =>
      appendLog(e.id, { t: e.stream === 'err' ? 'err' : 'out', x: e.line }))
    const offExit = native.onSessionExit(e =>
      appendLog(
        e.id,
        { t: 'sys', x: `process exited${e.code !== null ? ` · code ${e.code}` : ''}` },
        e.code === 0 || e.code === null ? 'idle' : 'error',
      ))
    return () => { offOut(); offExit() }
  }, [])

  // persistence: restore board/schedules/settings/tools on launch, save on change
  const hydrated = useRef(false)
  useEffect(() => {
    native.loadStateFile().then(json => {
      if (json) {
        try {
          const p = JSON.parse(json) as Partial<PersistedState>
          dispatch(s => ({
            ...s,
            tasks: p.tasks ?? s.tasks,
            crons: p.crons ?? s.crons,
            settings: p.settings ?? s.settings,
            toolsCatalog: p.toolsCatalog ?? s.toolsCatalog,
            agentTypes: p.agentTypes ?? s.agentTypes,
            integrations: p.integrations ?? s.integrations,
          }))
        } catch { /* corrupt state file — start fresh */ }
      }
      hydrated.current = true
    }).catch(() => { hydrated.current = true })
  }, [])

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
    }
    saveTimer.current = window.setTimeout(() => {
      native.saveStateFile(JSON.stringify(persisted)).catch(() => {})
    }, 800)
  }, [state.tasks, state.crons, state.settings, state.toolsCatalog, state.agentTypes, state.integrations])

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
      events: [{ id: mkId('e'), type, agentId, text, time: 'just now' }].concat(s.events),
    }))
  }, [])

  const doAsk = useCallback(() => {
    dispatch(s => {
      const running = s.agents.filter(a => a.status === 'running').length
      const needs = s.agents.filter(a => a.status === 'needs').length
      let reply = `${running} agents are running right now. Claude Code has rate limiting passing tests, Codex fixed the auth redirect loop, and Gemini CLI is paused mid-refactor.`
      if (needs) reply += ' Aider is still waiting on your migration approval.'
      return { ...s, messages: s.messages.concat([{ id: mkId('m'), role: 'master', kind: 'text', text: reply }]) }
    })
  }, [])

  const doRoute = useCallback((text: string) => {
    dispatch(s => {
      let agents = s.agents.slice()
      const idle = agents.find(a => a.status === 'idle')
      let target: Agent
      let action: string
      if (idle) {
        action = 'resumed'
        target = { ...idle, status: 'running', fi: 0, log: idle.log.concat([{ t: 'sys', x: 'routed by Master' }, { t: 'you', x: text }]) }
        agents = agents.map(a => (a.id === idle.id ? target : a))
      } else {
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22) || 'task'
        target = {
          id: mkId('a'), name: 'Claude Code', short: 'CC', color: '#E8A87C',
          repo: 'sandbox', branch: `feat/${slug}`, status: 'running', model: 'claude-sonnet-4.5',
          fi: 0, feed: CLAUDE_FEED, memory: mkMemory(), tools: mkTools(),
          log: [{ t: 'sys', x: `new session · sandbox @ feat/${slug}` }, { t: 'you', x: text }],
          ...defaultDetail(),
        }
        action = 'spun up'
        agents = agents.concat([target])
      }
      const routeMsg: Message = {
        id: mkId('m'), role: 'master', kind: 'route', text: 'Parsed your request — routing it now:',
        routes: [{ name: target.name, color: target.color, repo: `${target.repo} · ${target.branch}`, task: text, action }],
      }
      const focusedIds = s.focusedIds.slice()
      focusedIds[s.activePane] = target.id
      return { ...s, agents, messages: s.messages.concat([routeMsg]), focusedIds, view: 'workspace' }
    })
    flash('Task routed to an agent')
    logEvent('route', null, `Routed “${text.slice(0, 48)}”`)
  }, [flash, logEvent])

  const doBuildUI = useCallback((text: string) => {
    const t = text.toLowerCase()
    const topic = /coverage/.test(t) ? 'Test coverage'
      : /latency|perf|speed/.test(t) ? 'Latency'
      : /cost|spend|budget|token/.test(t) ? 'Cost & tokens'
      : /error|failure|crash/.test(t) ? 'Error rate'
      : /throughput|traffic|request/.test(t) ? 'Throughput'
      : 'Metrics'
    const title = `${topic} panel`
    const mid = mkId('m')
    const bars = Array.from({ length: 7 }, () => 0.3 + Math.random() * 0.7)
    dispatch(s => ({
      ...s,
      messages: s.messages.concat([{ id: mid, role: 'master', kind: 'buildui', buildUI: { title, stage: 0, done: false, bars } }]),
    }))
    const setStage = (stage: number, done: boolean) => dispatch(s => ({
      ...s,
      messages: s.messages.map(m => m.id === mid && m.buildUI ? { ...m, buildUI: { ...m.buildUI, stage, done } } : m),
    }))
    pending.current.push(window.setTimeout(() => setStage(1, false), 650))
    pending.current.push(window.setTimeout(() => setStage(2, false), 1350))
    pending.current.push(window.setTimeout(() => setStage(3, false), 2100))
    pending.current.push(window.setTimeout(() => {
      setStage(4, true)
      logEvent('build', null, `Built a custom panel: ${title}`)
      flash('Mounted a custom panel')
    }, 2900))
  }, [flash, logEvent])

  const doBuild = useCallback((text: string) => {
    if (/\b(panel|dashboard|ui|widget|custom view|interface)\b/i.test(text)) {
      doBuildUI(text)
      return
    }
    const isTool = /tool|integration|mcp/i.test(text)
    dispatch(s => {
      if (isTool) {
        const name = text.replace(/build( a| the| me)?/i, '').trim().slice(0, 26) || 'custom-tool'
        const tool: CatalogTool = { id: mkId('t'), name, desc: 'Generated by Master from your request.', perm: 'Ask first', agents: 0, built: true }
        return {
          ...s,
          toolsCatalog: s.toolsCatalog.concat([tool]),
          messages: s.messages.concat([{
            id: mkId('m'), role: 'master', kind: 'build',
            build: { kind: 'tool', title: name, detail: 'Added to the tool registry with Ask-first permission.', view: 'tools' },
          }]),
        }
      }
      const name = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22) || 'scheduled-job'
      const cron: Cron = { id: mkId('c'), name, schedule: '0 3 * * *', human: 'Every day · 3:00 AM', target: 'api-gateway', agent: 'Claude Code', color: '#E8A87C', on: true, built: true, last: '—' }
      return {
        ...s,
        crons: s.crons.concat([cron]),
        messages: s.messages.concat([{
          id: mkId('m'), role: 'master', kind: 'build',
          build: { kind: 'cron', title: name, detail: 'Every day · 3:00 AM · runs Claude Code on api-gateway.', view: 'crons' },
        }]),
      }
    })
    flash(isTool ? 'Built a new tool' : 'Built a new schedule')
    logEvent('build', null, isTool ? 'Built a new tool' : 'Built a new schedule')
  }, [doBuildUI, flash, logEvent])

  const actions = useMemo<ConductorActions>(() => ({
    setView: v => dispatch(s => ({ ...s, view: v })),
    setComposer: v => dispatch(s => ({ ...s, composer: v })),

    send: () => {
      dispatch(s => {
        const text = s.composer.trim()
        if (!text) return s
        const mode = classify(text)
        if (mode === 'ask') later(600, doAsk)
        else if (mode === 'build') later(650, () => doBuild(text))
        else later(650, () => doRoute(text))
        return { ...s, messages: s.messages.concat([{ id: mkId('u'), role: 'you', kind: 'text', text }]), composer: '' }
      })
    },

    focusComposer: () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-composer]')
      el?.focus()
    },

    setActivePane: i => dispatch(s => ({ ...s, activePane: i })),

    focusTab: id => dispatch(s => {
      const focusedIds = s.focusedIds.slice()
      focusedIds[s.activePane] = id
      return { ...s, focusedIds, view: 'workspace' }
    }),

    toggleSplit: () => dispatch(s => {
      if (s.splitCount === 2) return { ...s, splitCount: 1, activePane: 0 }
      const other = s.agents.find(a => a.id !== s.focusedIds[0]) || s.agents[0]
      const focusedIds = s.focusedIds.slice()
      if (!focusedIds[1]) focusedIds[1] = other.id
      return { ...s, splitCount: 2, focusedIds }
    }),

    closePane: i => dispatch(s => {
      if (s.splitCount === 1) return s
      const keep = s.focusedIds[i === 0 ? 1 : 0]
      return { ...s, splitCount: 1, activePane: 0, focusedIds: [keep, s.focusedIds[1]] }
    }),

    newSession: () => dispatch(s => {
      const id = mkId('a')
      const target = {
        id, name: 'Claude Code', short: 'CC', color: '#E8A87C',
        repo: 'untitled', branch: 'main', status: 'running' as const, model: 'claude-sonnet-4.5',
        fi: 0, feed: CLAUDE_FEED, memory: mkMemory(), tools: mkTools(),
        log: [
          { t: 'sys' as const, x: 'new session created · untitled @ main' },
          { t: 'out' as const, x: 'workspace ready — awaiting instructions' },
        ],
        ...defaultDetail(),
      }
      const focusedIds = s.focusedIds.slice()
      focusedIds[s.activePane] = id
      return { ...s, agents: s.agents.concat([target]), focusedIds, view: 'workspace' }
    }),

    resume: id => {
      const agent = stateRef.current.agents.find(a => a.id === id)
      if (agent?.kind === 'real' && agent.cmd && agent.status !== 'running') {
        const parts = agent.cmd.split(/\s+/)
        native.spawnSession(id, parts[0], parts.slice(1), agent.cwd || undefined).catch(() => {})
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

    approve: aid => {
      dispatch(s => {
        const agents = s.agents.map(a => a.id === aid
          ? { ...a, status: 'running' as const, feed: AIDER_APPROVE_FEED, fi: 0, log: a.log.concat([{ t: 'sys' as const, x: 'approved by you · resuming' }]) }
          : a)
        const messages = s.messages
          .map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'approved' as const } } : m))
          .concat([{ id: mkId('m'), role: 'master', kind: 'text', text: 'Approved. Aider is applying the migration on billing-service and running the webhook tests now.' }])
        const focusedIds = s.focusedIds.slice()
        focusedIds[s.activePane] = aid
        return { ...s, agents, messages, focusedIds, view: 'workspace' }
      })
      flash('Approved — Aider resumed')
      logEvent('done', aid, 'Approved migration · agent resumed')
    },

    deny: aid => {
      dispatch(s => {
        const agents = s.agents.map(a => a.id === aid
          ? { ...a, status: 'idle' as const, log: a.log.concat([{ t: 'sys' as const, x: 'denied · migration discarded, session paused' }]) }
          : a)
        const messages = s.messages
          .map(m => (m.escFor === aid && m.esc ? { ...m, esc: { ...m.esc, resolved: true, decision: 'denied' as const } } : m))
          .concat([{ id: mkId('m'), role: 'master', kind: 'text', text: 'Denied. Aider discarded the pending migration and paused. Tell me how you’d like to proceed.' }])
        return { ...s, agents, messages }
      })
      flash('Denied — Aider paused')
      logEvent('escalate', aid, 'Denied migration · agent paused')
    },

    gotoNeeds: () => dispatch(s => {
      const needsAgent = s.agents.find(a => a.status === 'needs')
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
      if (n.kind === 'escalate' && n.agentId) {
        const focusedIds = next.focusedIds.slice()
        focusedIds[next.activePane] = n.agentId
        return { ...next, focusedIds, view: 'workspace' }
      }
      if (n.kind === 'done' && n.agentId) return { ...next, drawer: { kind: 'diff', agentId: n.agentId } }
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
      logEvent('done', id, 'Approved changes · merged to main')
      flash('Changes approved & merged')
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

    newRealSession: (command, cwd) => {
      const parts = command.trim().split(/\s+/)
      if (!parts[0]) return
      const id = mkId('a')
      const bin = parts[0].split('/').pop() || parts[0]
      const REAL_COLORS = ['#7FD1FF', '#F5C451', '#3DDC97', '#FF9B9B', '#C77DFF', '#E8A87C']
      const color = REAL_COLORS[Math.floor(Math.random() * REAL_COLORS.length)]
      const dir = cwd.trim()
      const agent: Agent = {
        id, name: bin, short: bin.slice(0, 2).toUpperCase(), color,
        repo: dir ? dir.split('/').pop() || dir : '~', branch: 'live',
        status: 'running', model: command.trim(), kind: 'real', cmd: command.trim(), cwd: dir,
        fi: 0, feed: [], memory: mkMemory(), tools: mkTools(),
        log: [{ t: 'sys', x: `spawning · ${command.trim()}${dir ? ` @ ${dir}` : ''}` }],
        ...defaultDetail(),
      }
      dispatch(s => {
        const focusedIds = s.focusedIds.slice()
        focusedIds[s.activePane] = id
        return { ...s, agents: s.agents.concat([agent]), focusedIds, view: 'workspace' }
      })
      native.spawnSession(id, parts[0], parts.slice(1), dir || undefined).catch(err => {
        dispatch(s => ({
          ...s,
          agents: s.agents.map(a => a.id === id
            ? { ...a, status: 'error' as const, log: a.log.concat([{ t: 'err', x: String(err) }]) }
            : a),
        }))
      })
      logEvent('route', id, `Launched real session · ${command.trim()}`)
      flash('Session launched')
    },

    sendInput: (id, text) => {
      dispatch(s => ({
        ...s,
        agents: s.agents.map(a => a.id === id
          ? { ...a, log: a.log.concat([{ t: 'you', x: text }]) }
          : a),
      }))
      native.writeSession(id, `${text}\n`).catch(err => {
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
  }), [doAsk, doBuild, doRoute, flash, later, logEvent])

  // ⌘K / Ctrl+K toggles the command palette; Escape closes overlays
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        dispatch(s => ({ ...s, paletteOpen: !s.paletteOpen, paletteQuery: '' }))
      } else if (e.key === 'Escape') {
        dispatch(s => ({ ...s, paletteOpen: false, notifOpen: false, drawer: null }))
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
