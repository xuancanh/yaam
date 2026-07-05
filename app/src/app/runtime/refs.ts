// The declaration-cycle refs shared across the runtime sub-hooks. Runtimes are
// mutually recursive (Master ↔ monitor ↔ watcher ↔ addon agent), so each sub-hook
// sets its own `*Ref.current` and reads the others through these refs — which lets
// the sub-hooks be built in a plain top-to-bottom order without a cycle.
import { useRef } from 'react'
import type { MutableRefObject } from 'react'

export interface RuntimeRefs {
  masterEventRef: MutableRefObject<(note: string, agentId?: string) => void>
  monitorEventRef: MutableRefObject<(id: string, note: string) => Promise<void> | void>
  fireAddonHookRef: MutableRefObject<(hook: import('../../core/types').AddonHookName, event: Record<string, unknown>) => void>
  runAddonAgentRef: MutableRefObject<(addonId: string, note: string) => Promise<string>>
  runWatcherRef: MutableRefObject<(taskId: string, note: string) => void>
  spawnTaskSessionRef: MutableRefObject<(taskId: string, extraInstructions?: string) => string | null>
  startIntegrationsRef: MutableRefObject<() => void>
  /** sessions the user stopped via ■ — their exit is a STOP, not a completion */
  userStoppedRef: MutableRefObject<Set<string>>
  /** one-shot user approvals for Ask-first Master tools (consumed on use) */
  toolApprovalsRef: MutableRefObject<Set<string>>
  /** fast task→session bindings before React commits agentId */
  taskSessionsRef: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
}

export function useRuntimeRefs(): RuntimeRefs {
  const masterEventRef = useRef<(note: string, agentId?: string) => void>(() => {})
  const monitorEventRef = useRef<(id: string, note: string) => Promise<void> | void>(() => {})
  const fireAddonHookRef = useRef<(hook: import('../../core/types').AddonHookName, event: Record<string, unknown>) => void>(() => {})
  const runAddonAgentRef = useRef<(addonId: string, note: string) => Promise<string>>(async () => 'agent not ready')
  const runWatcherRef = useRef<(taskId: string, note: string) => void>(() => {})
  const spawnTaskSessionRef = useRef<(taskId: string, extraInstructions?: string) => string | null>(() => null)
  const startIntegrationsRef = useRef<() => void>(() => {})
  const userStoppedRef = useRef<Set<string>>(new Set())
  const toolApprovalsRef = useRef<Set<string>>(new Set())
  const taskSessionsRef = useRef<Map<string, { taskId: string; workspaceId: string }>>(new Map())
  return {
    masterEventRef, monitorEventRef, fireAddonHookRef, runAddonAgentRef, runWatcherRef,
    spawnTaskSessionRef, startIntegrationsRef, userStoppedRef, toolApprovalsRef, taskSessionsRef,
  }
}
