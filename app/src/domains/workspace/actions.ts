// Workspace-domain actions: switch (replaying queued Master events), create,
// rename, and delete (tearing down the workspace's sessions). Composed into the
// provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import type { Agent, WorkspaceData } from '../../core/entities'
import { mkId } from '../../shared/id'
import { switchWorkspaceIn } from './state'
import { MASTER_GREETING } from '../../core/data'
import { realSessionProcessPort } from '../session/ports'
import type { SessionProcessPort } from '../session/ports'
import { openWorkspaceWindow, closeWorkspaceWindow } from '../../infrastructure/native/windows'

export interface WorkspaceActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  runMaster: (note?: string) => void
  markUserStopped: (id: string) => void
  disposeSessionRuntime: (id: string) => void
  /** cancel any in-flight Master turn (workspace being deleted) */
  abortMaster: () => void
  /** native PTY capability for tearing down the workspace's sessions */
  port?: SessionProcessPort
}

export interface WorkspaceActions {
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  deleteWorkspace: (id: string) => void
  /** spin a workspace out into its own OS window; hides it from this switcher */
  openWorkspaceInWindow: (id: string) => void
  /** satellite closed — merge its final slice back and re-enable it here */
  reattachWorkspace: (id: string, data?: WorkspaceData, agents?: Agent[]) => void
  /** satellite periodic sync — merge its slice into the background copy (stays detached) */
  mergeDetachedWorkspace: (id: string, data: WorkspaceData, agents: Agent[]) => void
}

export function useWorkspaceActions(ctx: WorkspaceActionsCtx): WorkspaceActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createWorkspaceActions(ctx), [ctx.dispatch, ctx.stateRef, ctx.later, ctx.flash, ctx.runMaster, ctx.markUserStopped, ctx.disposeSessionRuntime, ctx.abortMaster, ctx.port])
}

/** The workspace actions as a plain factory (no React), for unit testing. */
export function createWorkspaceActions(ctx: WorkspaceActionsCtx): WorkspaceActions {
  const { dispatch, stateRef, later, flash } = ctx
  const port = ctx.port ?? realSessionProcessPort
  return {
    switchWorkspace: id => {
      // Master events that queued while this workspace was inactive
      const pending = stateRef.current.workspaceData[id]?.pendingMasterNotes ?? []
      dispatch(s => switchWorkspaceIn(s, id, MASTER_GREETING))
      if (pending.length) {
        later(600, () => {
          if (stateRef.current.activeWorkspace !== id) return
          void ctx.runMaster(`[events queued while this workspace was in the background]\n${pending.join('\n\n')}\n\nSummarize these for the user (grouped, brief).`)
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

    openWorkspaceInWindow: id => {
      const s0 = stateRef.current
      const detached0 = s0.detachedWorkspaces ?? []
      const name = s0.workspaces.find(w => w.id === id)?.name ?? 'Workspace'
      if (detached0.includes(id)) { void openWorkspaceWindow(id, name); return }
      if (s0.workspaces.length <= 1) { flash('Keep at least one workspace in this window'); return }
      // if it's the active workspace, switch away first so main stashes it into
      // workspaceData and stops rendering it — one window per workspace
      if (s0.activeWorkspace === id && !s0.workspaces.some(w => w.id !== id && !detached0.includes(w.id))) {
        flash('Keep at least one workspace in this window'); return
      }
      dispatch(s => {
        const detached = s.detachedWorkspaces ?? []
        let next = s
        if (s.activeWorkspace === id) {
          const fallback = s.workspaces.find(w => w.id !== id && !detached.includes(w.id))!
          next = switchWorkspaceIn(s, fallback.id, MASTER_GREETING)
        }
        return { ...next, detachedWorkspaces: [...(next.detachedWorkspaces ?? []), id] }
      })
      void openWorkspaceWindow(id, name)
      flash(`Opened “${name}” in a new window`)
    },

    reattachWorkspace: (id, data, agents) => dispatch(s => mergeWorkspaceSlice(s, id, data, agents, false)),

    mergeDetachedWorkspace: (id, data, agents) => dispatch(s => mergeWorkspaceSlice(s, id, data, agents, true)),

    deleteWorkspace: id => {
      const s0 = stateRef.current
      if (s0.workspaces.length <= 1) {
        flash('Cannot delete the last workspace')
        return
      }
      // a spun-out workspace closes its window first, then tears down
      if ((s0.detachedWorkspaces ?? []).includes(id)) void closeWorkspaceWindow(id)
      ctx.abortMaster() // cancel any in-flight Master turn tied to this teardown
      // kill the workspace's sessions and tear down all their runtime state
      for (const a of s0.agents.filter(a => a.workspaceId === id)) {
        ctx.markUserStopped(a.id)
        port.killSession(a.id).catch(() => {})
        ctx.disposeSessionRuntime(a.id)
        port.removeSession(a.id).catch(() => {})
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
          detachedWorkspaces: (next.detachedWorkspaces ?? []).filter(w => w !== id),
        }
      })
      flash('Workspace deleted')
    },
  }
}

/** Merge a satellite's authoritative workspace slice back into this (main) state.
 *  `reattach` also removes the workspace from the detached set (its window closed);
 *  a plain sync keeps it detached. The workspace's own sessions are replaced with
 *  the satellite's copy; sessions in other workspaces are untouched. */
function mergeWorkspaceSlice(s: AppState, id: string, data: WorkspaceData | undefined, agents: Agent[] | undefined, keepDetached: boolean): AppState {
  const workspaceData = data ? { ...s.workspaceData, [id]: data } : s.workspaceData
  const nextAgents = agents ? [...s.agents.filter(a => a.workspaceId !== id), ...agents] : s.agents
  const detached = s.detachedWorkspaces ?? []
  return {
    ...s,
    workspaceData,
    agents: nextAgents,
    detachedWorkspaces: keepDetached ? detached : detached.filter(w => w !== id),
  }
}
