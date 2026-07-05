// Master + scheduler: the Master agent runtime (owns its loop state), the
// proactive-event routing that either runs Master now or stashes the note for a
// background workspace, and the cron/scheduled-task ticker. Sets masterEventRef.
// Depends on the session runtime (launch/attention) and the addon subsystem
// (Master can drive addons).
import { useMemo, useRef } from 'react'
import { dispatch } from '../../core/store'
import { createMasterRuntime } from '../../domains/master/master-runtime'
import type { MasterRuntime } from '../../domains/master/master-runtime'
import { useSchedulerRuntime } from '../../domains/schedules/runtime'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'
import type { SessionRuntime } from './session'
import type { AddonSubsystem } from './addon'

export interface MasterSubsystem {
  runMaster: MasterRuntime['run']
  abortMaster: () => void
}

export function useMasterSubsystem(k: ConductorKernel, refs: RuntimeRefs, session: SessionRuntime, addon: AddonSubsystem): MasterSubsystem {
  const { stateRef, widOf, logEvent, notify, flash } = k
  const { masterEventRef, toolApprovalsRef, userStoppedRef, fireAddonHookRef } = refs

  // cron + scheduled-task ticker
  useSchedulerRuntime(useMemo(() => ({
    stateRef, logEvent, notify, launchSession: session.launchSession, spawnTaskSession: session.spawnTaskSession,
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
  }), [stateRef, logEvent, notify, session.launchSession, session.spawnTaskSession, fireAddonHookRef]))

  const masterRef = useRef<MasterRuntime>(undefined)
  if (!masterRef.current) {
    masterRef.current = createMasterRuntime({
      stateRef, dispatch, toolApprovalsRef, userStoppedRef,
      disposeAddon: addon.disposeAddon, launchSession: session.launchSession, launchFromTemplate: session.launchFromTemplate,
      armResponseWatch: session.armResponseWatch,
      sessionScreenTail: session.sessionScreenTail, logEvent, flash,
      applyAgentStatus: session.applyAgentStatus, setNeedsInput: session.setNeedsInput, makeAddonApi: addon.makeAddonApi,
    })
  }
  const runMaster = masterRef.current.run
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

  return { runMaster, abortMaster: () => masterRef.current!.abort() }
}
