// Addon subsystem: the permission-scoped addon API, the per-addon agent runtime,
// the customization-chat editor + package install runtime, and the lifecycle-hook
// fan-out. Sets fireAddonHookRef + runAddonAgentRef. Depends on the session
// runtime for launch/spawn (an addon's API can launch sessions/tasks). A plain
// factory (no effects) — composed by createAppRuntime.
import type { MutableRefObject } from 'react'
import type { AddonHookName, Addon } from '../../core/types'
import type { ApiMessage } from '../../master'
import type { AddonApi } from '../../core/addons'
import { enforcePermissions, execAddonHook } from '../../core/addons'
import { dispatch } from '../../core/store'
import { createAddonApi } from '../../domains/addons/addon-api'
import { createAddonAgentRuntime } from '../../domains/addons/agent-runtime'
import { createAddonRuntime } from '../../domains/addons/runtime'
import type { ConductorKernel } from '../conductor-runtime'
import type { RuntimeRefs } from './refs'
import type { SessionRuntime } from './session'

export interface AddonSubsystem {
  makeAddonApi: (addonId: string) => AddonApi
  disposeAddon: (addonId: string) => void
  installPackage: (json: string, source: Addon['source']) => void
  sendAddonChat: (id: string, text: string) => void
}

export function createAddonSubsystem(k: ConductorKernel, refs: RuntimeRefs, session: SessionRuntime): AddonSubsystem {
  const { stateRef, flash, logEvent, later, notify } = k
  const { fireAddonHookRef, runAddonAgentRef, userStoppedRef, runWatcherRef } = refs

  const makeAddonApiRaw = (addonId: string): AddonApi => createAddonApi({
    stateRef, dispatch,
    launchSession: (command, cwd, name) => session.launchSession(command, cwd, name),
    launchFromTemplate: (templateId, task) => session.launchFromTemplate(templateId, task),
    spawnSessionForTask: id => session.spawnSessionForTask(id),
    pushTaskChat: session.pushTaskChat, flash,
    logEvent: text => logEvent('edit', null, text),
    notify: (title, detail) => notify('done', title, detail, null),
    later,
    markUserStopped: id => userStoppedRef.current.add(id),
    fireAddonHook: (hook, event) => fireAddonHookRef.current(hook, event),
    runWatcher: (taskId, note) => runWatcherRef.current(taskId, note),
    wakeAgent: (aid, note) => runAddonAgentRef.current(aid, note),
  }, addonId)

  const makeAddonApi = (addonId: string): AddonApi => {
    const addon = stateRef.current.addons.find(a => a.id === addonId)
    return enforcePermissions(makeAddonApiRaw(addonId), addon?.enabled ? addon.granted : [])
  }

  const editorHistories: MutableRefObject<Map<string, ApiMessage[]>> = { current: new Map() }
  const agent = createAddonAgentRuntime({ stateRef, logEvent, makeAddonApi })
  const runAddonAgent = agent.run
  runAddonAgentRef.current = runAddonAgent
  const disposeAddon = (id: string) => {
    agent.dispose(id)
    editorHistories.current.delete(id)
  }

  const addonRuntime = createAddonRuntime({ stateRef, flash, logEvent, editorHistories })

  const fireAddonHook = (hook: AddonHookName, event: Record<string, unknown>) => {
    void execAddonHook(stateRef.current, hook, event, makeAddonApi)
    for (const a of stateRef.current.addons) {
      if (a.enabled && a.agent?.on?.includes(hook)) {
        void runAddonAgent(a.id, `[${hook}] ${JSON.stringify(event)}\n\nReact per your instructions; do nothing if this event is irrelevant.`)
      }
    }
  }
  fireAddonHookRef.current = fireAddonHook

  return { makeAddonApi, disposeAddon, installPackage: addonRuntime.installPackage, sendAddonChat: (id, text) => { void addonRuntime.sendAddonChat(id, text) } }
}
