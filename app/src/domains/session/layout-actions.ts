// Session layout actions: pane and tab-group transitions for the workspace grid.
// Pure state transitions over the shared store — no runtime/native coupling — so
// they read dispatch directly (like shell actions). Composed into the provider's
// action surface.
import { useMemo } from 'react'
import { dispatch } from '../../core/store'
import { activeGroupOf, focusSessionIn, mkGroup } from './layout-state'
import { withActiveGroup } from '../../store/state-helpers'

export interface SessionLayoutActions {
  setActivePane: (i: number) => void
  focusTab: (id: string) => void
  activateGroup: (id: string) => void
  closeGroup: (id: string) => void
  setPaneLayout: (n: number, stacked?: boolean) => void
  assignPane: (i: number, id: string) => void
  closePane: (i: number) => void
  toggleMaximize: (i: number) => void
  minimizePane: (i: number) => void
  restoreSession: (id: string) => void
  setRowSplit: (v: number) => void
  setColSplit: (row: number, v: number) => void
}

export function useSessionLayoutActions(): SessionLayoutActions {
  return useMemo(() => ({
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
  }), [])
}
