// Master runtime: owns the single global Master loop's mutable state (busy flag,
// coalesced-event queue, last-event dedup, cancellation) and exposes run/abort.
// Non-React factory wired with typed ports (the rest of MasterCtx). abort() is
// called when a workspace is torn down.
import { AbortRegistry } from '../../core/abort-registry'
import { runMasterLoop } from './runner'
import type { MasterCtx } from './runner'

// everything MasterCtx needs except the per-run mutable state the runtime owns
export type MasterPorts = Omit<MasterCtx, 'masterBusyRef' | 'masterQueued' | 'lastEventRef' | 'signal'>

export interface MasterRuntime {
  run: (eventNote?: string) => void
  abort: () => void
}

export function createMasterRuntime(ports: MasterPorts): MasterRuntime {
  const masterBusyRef = { current: false }
  const masterQueued: { current: { note?: string } | null } = { current: null }
  const lastEventRef: { current: { note: string; at: number } | null } = { current: null }
  const aborts = new AbortRegistry()
  return {
    run: (eventNote) => {
      void runMasterLoop({
        ...ports, masterBusyRef, masterQueued, lastEventRef,
        signal: () => aborts.signal('master'),
      }, eventNote)
    },
    abort: () => aborts.abort('master'),
  }
}
