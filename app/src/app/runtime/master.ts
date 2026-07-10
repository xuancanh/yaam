// Master + scheduler: the Master agent runtime (owns its loop state), the
// proactive-event routing that either runs Master now or stashes the note for a
// background workspace, and the cron/scheduled-task ticker. Sets masterEventRef.
// Depends on the session runtime (launch/attention) and the addon subsystem
// (Master can drive addons). A plain factory with a start/dispose lifecycle;
// Plain factory (no React) — composed by createAppRuntime.
import { dispatch } from '../../core/store'
import { browserClock, type StatePort } from '../../core/ports'
import * as native from '../../core/native'
import { createMasterRuntime } from '../../domains/master/master-runtime'
import type { MasterRuntime } from '../../domains/master/master-runtime'
import { createSchedulerRuntime } from '../../domains/schedules/runtime'
import { buildChatSession } from '../../domains/chat/actions'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'
import type { SessionRuntime } from './session'
import type { AddonSubsystem } from './addon'

export interface MasterSubsystem {
  runMaster: MasterRuntime['run']
  abortMaster: () => void
  /** arm the scheduler ticker */
  start: () => void
  /** stop the scheduler + abort any in-flight Master turn */
  dispose: () => void
}

/** Writes a line to a session's PTY as the master actor (routes through the
 *  shared command). Master's own tool-permission gates apply before it. */
export type MasterSendLine = (sid: string, text: string) => void
/** Flags + kills a session as the master actor (routes through stop_session). */
export type MasterStopLine = (sid: string) => void

export function createMasterSubsystem(k: ConductorKernel, refs: RuntimeRefs, session: SessionRuntime, addon: AddonSubsystem, runChatMessage?: (agentId: string, text: string) => void, sendLine?: MasterSendLine, stopLine?: MasterStopLine): MasterSubsystem {
  const { stateRef, widOf, logEvent, notify, flash } = k
  const { masterEventRef, toolApprovalsRef, userStoppedRef, fireAddonHookRef } = refs
  const state: StatePort = { get: () => stateRef.current, update: dispatch, subscribe: () => () => {} }

  // a durable agent's scheduled loop: deliver the prompt into its dedicated
  // "scheduled" conversation (created lazily), running in the background
  const sendAgentChat = (durableAgentId: string, prompt: string, scheduleName: string): string | null => {
    if (!runChatMessage) return null
    const s = stateRef.current
    const durable = (s.durableAgents ?? []).find(d => d.id === durableAgentId && !d.archived)
    if (!durable) return null
    let conv = s.agents.find(a => a.kind === 'chat' && !a.archived && a.durableAgentId === durableAgentId && (a.chatTags ?? []).includes('scheduled'))
    if (!conv) {
      conv = buildChatSession(s, { durableAgentId, name: `${durable.name} · scheduled`, tags: ['scheduled'] })
      const created = conv
      dispatch(s2 => ({ ...s2, agents: s2.agents.concat([created]) }))
    }
    runChatMessage(conv.id, `[schedule "${scheduleName}" fired] ${prompt}`)
    return conv.id
  }

  const scheduler = createSchedulerRuntime({
    state, clock: browserClock, logEvent, notify,
    launchSession: session.launchSession, spawnTaskSession: session.spawnTaskSession,
    sendAgentChat,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    canLaunch: native.isTauri,
  })

  const master = createMasterRuntime({
    stateRef, dispatch, toolApprovalsRef, userStoppedRef,
    disposeAddon: addon.disposeAddon, launchSession: session.launchSession, launchFromTemplate: session.launchFromTemplate,
    armResponseWatch: session.armResponseWatch,
    sessionScreenTail: session.sessionScreenTail, logEvent, flash,
    applyAgentStatus: session.applyAgentStatus, setNeedsInput: session.setNeedsInput, makeAddonApi: addon.makeAddonApi,
    sendLine, stopLine,
  })
  const runMaster = master.run
  masterEventRef.current = (note, agentId) => {
    const s = stateRef.current
    const wid = widOf(s, agentId ?? null)
    if (wid === s.activeWorkspace) { void runMaster(note); return }
    dispatch(s2 => {
      const d = s2.workspaceData[wid]
      if (!d) return s2
      return { ...s2, workspaceData: { ...s2.workspaceData, [wid]: { ...d, pendingMasterNotes: d.pendingMasterNotes.concat([note]).slice(-10) } } }
    })
  }

  return {
    runMaster,
    abortMaster: () => master.abort(),
    start: () => scheduler.start(),
    dispose: () => { scheduler.dispose(); master.abort() },
  }
}
