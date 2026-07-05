// Monitor runtime: owns the per-session monitor registries (private LLM history,
// busy set, queued note, cancellation) and exposes run/dispose. A non-React
// factory wired with typed ports — the provider instantiates it once and calls
// run() (via monitorEventRef / the settle watcher) and dispose() on session teardown.
import type { MutableRefObject } from 'react'
import type { AppState, EscOption, EventType, NotifKind } from '../../core/types'
import type { ApiMessage } from '../../master'
import { AbortRegistry } from '../../core/abort-registry'
import { runMonitorLoop } from './monitor-runner'

export interface MonitorPorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  setNeedsInput: (id: string, question: string, options?: EscOption[], cursorNum?: number) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  masterEvent: (note: string, agentId?: string) => void
}

export interface MonitorRuntime {
  run: (id: string, note: string) => void
  dispose: (id: string) => void
}

export function createMonitorRuntime(ports: MonitorPorts): MonitorRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const queue = new Map<string, string>()
  const aborts = new AbortRegistry()
  return {
    run: (id, note) => { void runMonitorLoop({ ...ports, histories, busy, queue, aborts }, id, note) },
    dispose: (id) => {
      aborts.abort(id) // cancel any in-flight monitor turn for this session
      histories.delete(id)
      busy.delete(id)
      queue.delete(id)
    },
  }
}
