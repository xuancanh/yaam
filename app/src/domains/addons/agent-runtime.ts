// Addon-agent runtime: owns the per-addon agent registries (private LLM history,
// busy set, cancellation) and runs an addon's own mini-Master turn (its tools are
// the addon's permission-scoped API). Non-React factory wired with typed ports.
// The addon EDITOR history is separate (owned by the provider, shared with the
// editor runtime + removal path).
import type { MutableRefObject } from 'react'
import type { AppState, EventType } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildCfg, hasCreds } from '../../master'
import type { AddonApi } from '../../core/addons'
import { AbortRegistry, isAbortError } from '../../core/abort-registry'
import { runAddonAgentTurn } from './addon-agent'

export interface AddonAgentPorts {
  stateRef: MutableRefObject<AppState>
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  makeAddonApi: (addonId: string) => AddonApi
}

export interface AddonAgentRuntime {
  run: (addonId: string, note: string) => Promise<string>
  dispose: (addonId: string) => void
}

export function createAddonAgentRuntime(ports: AddonAgentPorts): AddonAgentRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const aborts = new AbortRegistry()
  return {
    run: async (addonId, note) => {
      const st = ports.stateRef.current.settings
      const addon = ports.stateRef.current.addons.find(a => a.id === addonId)
      if (!addon?.agent) return 'this addon declares no agent'
      if (!addon.enabled) return 'addon is disabled'
      if (!addon.granted.includes('agent')) return 'permission "agent" not granted to this addon'
      if (!(st.masterEnabled && hasCreds(st))) return 'no brain configured — enable LLM Master in Settings'
      if (busy.has(addonId)) return 'agent is busy with a previous note — try again shortly'
      busy.add(addonId)
      try {
        let history = histories.get(addonId)
        if (!history) {
          history = []
          histories.set(addonId, history)
        }
        const reply = await runAddonAgentTurn(buildCfg(st, st.monitorModel || undefined), addon, note, history, ports.makeAddonApi(addonId), aborts.signal(addonId))
        return reply || '(acted without a reply)'
      } catch (e) {
        // the addon was removed mid-turn — stop quietly
        if (isAbortError(e) || aborts.signal(addonId).aborted) return 'agent cancelled'
        const msg = e instanceof Error ? e.message : String(e)
        ports.logEvent('escalate', null, `Addon agent "${addon.name}" error: ${msg}`)
        return `agent error: ${msg}`
      } finally {
        busy.delete(addonId)
        aborts.clear(addonId)
      }
    },
    dispose: (addonId) => {
      aborts.abort(addonId) // cancel any in-flight addon-agent turn
      histories.delete(addonId)
      busy.delete(addonId)
    },
  }
}
