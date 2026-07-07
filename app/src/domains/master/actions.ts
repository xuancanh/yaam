// Master chat actions: the composer, sending a message to Master (kicking off a
// turn when a brain is configured), focusing the composer, and resolving an
// Ask-first tool approval. Composed into the provider's action surface.
import { useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { AppState } from '../../core/types'
import { dispatch } from '../../core/store'
import { hasCreds } from '../../master'
import { mkId } from '../../shared/id'

export interface MasterActionsCtx {
  stateRef: MutableRefObject<AppState>
  later: (ms: number, fn: () => void) => void
  runMaster: (note?: string) => void
  toolApprovals: MutableRefObject<Set<string>>
}

export interface MasterActions {
  setComposer: (v: string) => void
  send: () => void
  /** send an explicit message to Master (used by the phone remote, which has no
   *  desktop composer) — same behavior as send() otherwise */
  sendMessage: (text: string) => void
  focusComposer: () => void
  resolveToolApproval: (id: string, approve: boolean) => void
}

export function useMasterActions(ctx: MasterActionsCtx): MasterActions {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createMasterActions(ctx), [ctx.stateRef, ctx.later, ctx.runMaster, ctx.toolApprovals])
}

/** Plain (non-React) factory for the Master chat actions. */
export function createMasterActions(ctx: MasterActionsCtx): MasterActions {
  const { stateRef, later, runMaster, toolApprovals } = ctx

  // side effects must stay OUT of the dispatch updater — React double-invokes
  // reducers in dev, which used to schedule two Master turns (the second
  // re-answered with nothing new = double replies)
  const sendMessage = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    dispatch(s => ({
      ...s,
      messages: s.messages.concat([{ id: mkId('u'), role: 'you', kind: 'text', text }]),
      composer: '',
    }))
    const st = stateRef.current.settings
    if (hasCreds(st) && st.masterEnabled) {
      later(50, () => { void runMaster() })
    } else {
      later(300, () => dispatch(s2 => ({
        ...s2,
        messages: s2.messages.concat([{
          id: mkId('m'), role: 'master', kind: 'text',
          text: hasCreds(s2.settings)
            ? 'My brain is switched off — enable “LLM Master” in Settings → Master Brain and I’ll take it from there.'
            : 'I need a brain first: pick a provider in Settings → Master Brain (API key, or AWS Bedrock with your credential chain) and flip the LLM Master toggle, then ask me again.',
        }]),
      })))
    }
  }

  return {
    setComposer: v => dispatch(s => ({ ...s, composer: v })),

    send: () => sendMessage(stateRef.current.composer),
    sendMessage,

    focusComposer: () => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-composer]')
      el?.focus()
    },

    resolveToolApproval: (id, approve) => {
      const pa = stateRef.current.pendingToolApprovals.find(x => x.id === id)
      dispatch(s => ({ ...s, pendingToolApprovals: s.pendingToolApprovals.filter(x => x.id !== id) }))
      if (!pa) return
      if (approve) toolApprovals.current.add(pa.toolId)
      later(50, () => {
        void runMaster(approve
          ? `[the user approved one use of "${pa.toolId}" — retry the blocked call now]`
          : `[the user denied "${pa.toolId}" — do not retry it; adjust your plan or ask the user]`)
      })
    },
  }
}
