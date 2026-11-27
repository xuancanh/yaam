// Addon-agent runtime: owns the per-addon agent registries (private LLM history,
// busy set, cancellation) and runs an addon's own mini-Master turn (its tools are
// the addon's permission-scoped API). Non-React factory wired with typed ports.
// The addon EDITOR history is separate (owned by the provider, shared with the
// editor runtime + removal path).
import type { MutableRefObject } from 'react'
import type { AppState, EventType } from '../../core/types'
import type { ApiMessage } from '../../master'
import { buildMonitorCfg, hasCreds } from '../../master'
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
  // Notes that arrive mid-turn (two sessions exiting seconds apart, an
  // agent.every wake) used to be dropped. They queue, bounded, and run as one
  // follow-up turn when the current one ends.
  const MAX_QUEUED = 8
  const queued = new Map<string, string[]>()
  const aborts = new AbortRegistry()
  const run = async (addonId: string, note: string): Promise<string> => {
      const st = ports.stateRef.current.settings
      const addon = ports.stateRef.current.addons.find(a => a.id === addonId)
      if (!addon?.agent) return 'this addon declares no agent'
      if (!addon.enabled) return 'addon is disabled'
      if (!addon.granted.includes('agent')) return 'permission "agent" not granted to this addon'
      if (!(st.masterEnabled && hasCreds(st))) return 'no brain configured — enable LLM Master in Settings'
      if (busy.has(addonId)) {
        const q = queued.get(addonId) ?? []
        q.push(note)
        if (q.length > MAX_QUEUED) q.splice(0, q.length - MAX_QUEUED)
        queued.set(addonId, q)
        return 'queued: the agent will handle this after its current turn'
      }
      busy.add(addonId)
      const runSignal = aborts.signal(addonId)
      try {
        let history = histories.get(addonId)
        if (!history) {
          history = []
          histories.set(addonId, history)
        }
        const reply = await runAddonAgentTurn(buildMonitorCfg(st), addon, note, history, ports.makeAddonApi(addonId), runSignal)
        return reply || '(acted without a reply)'
      } catch (e) {
        // the addon was removed mid-turn — stop quietly
        if (isAbortError(e) || runSignal.aborted) return 'agent cancelled'
        const msg = e instanceof Error ? e.message : String(e)
        ports.logEvent('escalate', null, `Addon agent "${addon.name}" error: ${msg}`)
        return `agent error: ${msg}`
      } finally {
        const released = aborts.clear(addonId, runSignal)
        if (released || !aborts.has(addonId)) busy.delete(addonId)
        const next = runSignal.aborted ? undefined : queued.get(addonId)
        queued.delete(addonId)
        if (next?.length && !busy.has(addonId)) {
          void run(addonId, next.length === 1 ? next[0] : `${next.length} events arrived while you were busy:\n\n${next.join('\n\n---\n\n')}`)
        }
      }
  }
  return {
    run,
    dispose: (addonId) => {
      aborts.abort(addonId) // cancel any in-flight addon-agent turn
      histories.delete(addonId)
      busy.delete(addonId)
      queued.delete(addonId)
    },
  }
}
