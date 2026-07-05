// Activity + notification service: append activity-feed events and notifications
// to the workspace that OWNS them (a session in a background workspace keeps
// reporting into its own stash, not the active view). Pure dispatch transitions
// over the shared store. Provided to the runtime runners and action slices.
import { useMemo } from 'react'
import type { AppState, EventType, NotifKind } from '../../core/types'
import { dispatch } from '../../core/store'
import { mkId } from '../../shared/id'

export interface ActivityService {
  /** the workspace that should own an event/notification for a session. */
  widOf: (s: AppState, agentId: string | null) => string
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
}

export function useActivityService(): ActivityService {
  return useMemo(() => {
    const widOf = (s: AppState, agentId: string | null): string => {
      if (!agentId) return s.activeWorkspace
      const agent = s.agents.find(a => a.id === agentId)
      return agent?.workspaceId && (s.workspaces.some(w => w.id === agent.workspaceId))
        ? agent.workspaceId
        : s.activeWorkspace
    }
    return {
      widOf,
      logEvent: (type, agentId, text) => {
        const item = { id: mkId('e'), type, agentId, text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
        dispatch(s => {
          const wid = widOf(s, agentId)
          if (wid === s.activeWorkspace) return { ...s, events: [item].concat(s.events).slice(0, 200) }
          const d = s.workspaceData[wid]
          if (!d) return s
          return { ...s, workspaceData: { ...s.workspaceData, [wid]: { ...d, events: [item].concat(d.events).slice(0, 200) } } }
        })
      },
      notify: (kind, title, detail, agentId) => {
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
      },
    }
  }, [])
}
