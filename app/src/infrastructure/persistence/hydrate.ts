// Pure hydration: turn a persisted (possibly legacy) snapshot into the concrete
// AppState to apply, plus the list of sessions whose terminals must be rebuilt.
// No dispatch, no terminals, no native calls — so migrations are unit-testable.
// The provider effect applies `next` and reattaches terminals for `restoredAgents`.
import type { AppState, Agent, Addon, BoardTask, PersistedState } from '../../core/types'
import { ALL_PERMISSIONS } from '../../core/addons'
import { mkMemory, mkTools } from '../../core/data'
import { estimateLogUsage } from '../../core/usage'
import { mkId, groupsFromLegacy } from '../../core/state-lib'
import { inferLegacyTerminalShell } from '../../store/state-helpers'

export interface HydrationOutcome {
  /** The fully-merged state to apply. */
  next: AppState
  /** Restored real sessions whose terminals the caller must rebuild/reattach. */
  restoredAgents: Agent[]
}

// the Routed column was removed — tasks parked there go back to Backlog
const migrateCols = (tasks: BoardTask[]): BoardTask[] =>
  tasks.map(t => ((t.col as string) === 'routed' ? { ...t, col: 'backlog' as const } : t))

export function buildHydration(p: Partial<PersistedState>, seed: AppState): HydrationOutcome {
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
  const workspaceData = Object.fromEntries(Object.entries(p.workspaceData ?? {}).map(([wid, d]) =>
    [wid, {
      ...d,
      tasks: migrateCols(d.tasks ?? []),
      crons: d.crons ?? [], messages: d.messages ?? [], events: d.events ?? [],
      notifications: d.notifications ?? [], minimizedIds: d.minimizedIds ?? [],
      pendingMasterNotes: d.pendingMasterNotes ?? [],
    }]))
  const next: AppState = {
    ...seed,
    tasks: migrateCols(p.tasks ?? seed.tasks),
    crons: p.crons ?? seed.crons,
    settings: { ...seed.settings, ...(p.settings || {}) },
    toolsCatalog: p.toolsCatalog?.some(t => t.id === 'launch_session')
      ? p.toolsCatalog.concat(seed.toolsCatalog.filter(s => !p.toolsCatalog!.some(t => t.id === s.id)))
      : seed.toolsCatalog,
    agentTypes: p.agentTypes
      ? seed.agentTypes
          .map(t => ({ ...t, ...(p.agentTypes!.find(x => x.id === t.id) ?? {}), resumeCmd: t.resumeCmd, resumeFallbackCmd: t.resumeFallbackCmd, probe: t.probe } as typeof t))
          .concat(p.agentTypes.filter(x => x.custom && !seed.agentTypes.some(t => t.id === x.id)))
      : seed.agentTypes,
    templates: p.templates ?? seed.templates ?? [],
    mcpServers: p.mcpServers ?? seed.mcpServers,
    skills: p.skills ?? seed.skills,
    personas: p.personas ?? seed.personas,
    skillRegistries: p.skillRegistries ?? seed.skillRegistries,
    chatAgentTypes: p.chatAgentTypes ?? seed.chatAgentTypes,
    agents: restoredAgents.length ? restoredAgents : seed.agents,
    groups,
    activeGroup,
    minimizedIds: (p.minimizedIds ?? []).filter(id => ids.has(id)),
    workspaces,
    activeWorkspace,
    workspaceData,
    addonStorage: p.addonStorage ?? {},
    addons: (p.addons ?? seed.addons).map(a => {
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
    messages: p.messages?.length ? p.messages : seed.messages,
    events: p.events ?? seed.events,
    notifications: p.notifications ?? seed.notifications,
  }
  return { next, restoredAgents }
}
