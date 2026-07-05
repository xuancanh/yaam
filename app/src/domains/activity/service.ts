// Activity + notification service: append activity-feed events and notifications
// to the workspace that OWNS them (a session in a background workspace keeps
// reporting into its own stash, not the active view). A plain factory over a
// StatePort — no React — provided to the runtime runners and action slices.
import { useMemo } from 'react'
import type { AppState, EventType, NotifKind } from '../../core/types'
import { createStorePort, type StatePort } from '../../core/ports'
import { mkId } from '../../shared/id'

export interface ActivityService {
  /** the workspace that should own an event/notification for a session. */
  widOf: (s: AppState, agentId: string | null) => string
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
}

const stamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function createActivityService(state: StatePort): ActivityService {
  const widOf = (s: AppState, agentId: string | null): string => {
    if (!agentId) return s.activeWorkspace
    const agent = s.agents.find(a => a.id === agentId)
    return agent?.workspaceId && s.workspaces.some(w => w.id === agent.workspaceId)
      ? agent.workspaceId
      : s.activeWorkspace
  }
  return {
    widOf,
    logEvent: (type, agentId, text) => {
      const item = { id: mkId('e'), type, agentId, text, time: stamp() }
      state.update(s => {
        const wid = widOf(s, agentId)
        if (wid === s.activeWorkspace) return { ...s, events: [item].concat(s.events).slice(0, 200) }
        const d = s.workspaceData[wid]
        if (!d) return s
        return { ...s, workspaceData: { ...s.workspaceData, [wid]: { ...d, events: [item].concat(d.events).slice(0, 200) } } }
      })
    },
    notify: (kind, title, detail, agentId) => {
      const item = { id: mkId('n'), kind, title, detail, time: stamp(), read: false, agentId }
      state.update(s => {
        const wid = widOf(s, agentId)
        if (wid === s.activeWorkspace) return { ...s, notifications: [item].concat(s.notifications).slice(0, 30) }
        const d = s.workspaceData[wid]
        if (!d) return s
        return { ...s, workspaceData: { ...s.workspaceData, [wid]: { ...d, notifications: [item].concat(d.notifications).slice(0, 30) } } }
      })
    },
  }
}

/** React adapter: build the service over the real store, memoized once. */
export function useActivityService(): ActivityService {
  return useMemo(() => createActivityService(createStorePort()), [])
}
