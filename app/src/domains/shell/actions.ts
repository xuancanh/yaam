// App-shell actions: top-level view switching, command palette, notifications,
// the inspector panel, the drawer, and the new-session dialog. Pure state
// transitions — no runtime coupling, so they read dispatch directly from the
// store. Composed into the provider's action surface.
import { useMemo } from 'react'
import { dispatch } from '../../core/store'
import { focusSessionIn } from '../../core/state-lib'
import type { ConductorActions } from '../../app/actions'

type ShellActions = Pick<ConductorActions,
  | 'setView' | 'openPalette' | 'closePalette' | 'setPaletteQuery'
  | 'toggleNotif' | 'readAllNotif' | 'clickNotif' | 'openPanel' | 'setPanelTab' | 'closePanel'
  | 'openAgent' | 'openDiff' | 'closeDrawer' | 'openNewSession' | 'closeNewSession' | 'gotoNeeds'>

export function useShellActions(): ShellActions {
  return useMemo(() => ({
    setView: v => dispatch(s => ({ ...s, view: v })),

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

    openPanel: (id, tab) => dispatch(s => ({ ...s, panel: { agentId: id, tab: tab || 'memory' } })),
    setPanelTab: tab => dispatch(s => (s.panel ? { ...s, panel: { ...s.panel, tab } } : s)),
    closePanel: () => dispatch(s => ({ ...s, panel: null })),

    openAgent: id => dispatch(s => ({ ...s, drawer: { kind: 'agent', agentId: id } })),
    openDiff: id => dispatch(s => ({ ...s, drawer: { kind: 'diff', agentId: id } })),
    closeDrawer: () => dispatch(s => ({ ...s, drawer: null })),

    openNewSession: () => dispatch(s => ({ ...s, newSessionOpen: true })),
    closeNewSession: () => dispatch(s => ({ ...s, newSessionOpen: false })),

    gotoNeeds: () => dispatch(s => {
      const needsAgent = s.agents.find(a => ((a.workspaceId ?? s.activeWorkspace) === s.activeWorkspace) && (a.status === 'needs' || a.status === 'error'))
      return needsAgent ? focusSessionIn(s, needsAgent.id) : s
    }),
  }), [])
}
