// Per-session configuration actions: rename, and toggle a session's memory
// entries / tools / tool permissions. Pure state transitions over the shared
// store. Composed into the provider's action surface.
import { useMemo } from 'react'
import { dispatch } from '../../core/store'
import { PERM_ORDER } from '../../core/data'

export interface SessionConfigActions {
  renameSession: (id: string, name: string) => void
  toggleMem: (aid: string, mid: string) => void
  toggleTool: (aid: string, tid: string) => void
  cyclePerm: (aid: string, tid: string) => void
}

export function useSessionConfigActions(): SessionConfigActions {
  return useMemo(() => createSessionConfigActions(), [])
}

/** Plain (non-React) factory for the per-session configuration actions. */
export function createSessionConfigActions(): SessionConfigActions {
  return {
    renameSession: (id, name) => dispatch(s => ({
      ...s,
      agents: s.agents.map(a => a.id === id
        ? { ...a, name: name.trim() || a.name, short: (name.trim() || a.name).slice(0, 2).toUpperCase(), nameIsDefault: false }
        : a),
    })),

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
  }
}
