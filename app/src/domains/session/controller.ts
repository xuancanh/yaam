// Session controller: the single owner of a session's process + terminal
// lifecycle — launch/resume/stop/archive/unarchive/delete/send plus the
// terminal-prompt answers. Composes the two port-backed action factories
// (./actions + ./prompt-actions) into one named interface so the composition
// root wires one session lifecycle, not several. The typed exit result and its
// fan-out live in ./exit + ./exit-handler; PTY/terminal effects go through
// SessionProcessPort — this domain never imports core/native directly.
import { useMemo } from 'react'
import { createSessionActions } from './actions'
import type { SessionActions, SessionActionsCtx } from './actions'
import { createSessionPromptActions } from './prompt-actions'
import type { SessionPromptActions, PromptActionsCtx } from './prompt-actions'

export type SessionControllerCtx = SessionActionsCtx & PromptActionsCtx
export type SessionController = SessionActions & SessionPromptActions

export function createSessionController(ctx: SessionControllerCtx): SessionController {
  return { ...createSessionActions(ctx), ...createSessionPromptActions(ctx) }
}

export function useSessionController(ctx: SessionControllerCtx): SessionController {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => createSessionController(ctx), [
    ctx.stateRef, ctx.flash, ctx.logEvent, ctx.markUserStopped, ctx.disposeSessionRuntime,
    ctx.launchSession, ctx.probeCliSession, ctx.armResponseWatch, ctx.appendTail, ctx.clearNeeds,
    ctx.bumpSettle, ctx.bufferOutput, ctx.recordTerminalSubmit, ctx.clearFlagged, ctx.port, ctx.execCommand,
  ])
}
