// Workspace-domain actions: switch (replaying queued Master events), create,
// rename, and delete (tearing down the workspace's sessions). Composed into the
// provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import { mkId } from '../../shared/id'
import { switchWorkspaceIn } from './state'
import { MASTER_GREETING } from '../../core/data'
import * as native from '../../core/native'

export interface WorkspaceActionsCtx {
  dispatch: (f: (s: AppState) => AppState) => void
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  flash: (t: string) => void
  runMaster: (note?: string) => void
  markUserStopped: (id: string) => void
  disposeSessionRuntime: (id: string) => void
}

export interface WorkspaceActions {
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  renameWorkspace: (id: string, name: string) => void
  deleteWorkspace: (id: string) => void
}

export function useWorkspaceActions(ctx: WorkspaceActionsCtx): WorkspaceActions {
  const { dispatch, stateRef, later, flash } = ctx
  return useMemo(() => ({
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

    deleteWorkspace: id => {
      const s0 = stateRef.current
      if (s0.workspaces.length <= 1) {
        flash('Cannot delete the last workspace')
        return
      }
      // kill the workspace's sessions and tear down all their runtime state
      for (const a of s0.agents.filter(a => a.workspaceId === id)) {
        ctx.markUserStopped(a.id)
        native.killSession(a.id).catch(() => {})
        ctx.disposeSessionRuntime(a.id)
        native.removeSession(a.id).catch(() => {})
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
        }
      })
      flash('Workspace deleted')
    },
  }), [dispatch, stateRef, later, flash, ctx])
}
