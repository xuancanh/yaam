// Watcher runtime: owns the per-task watcher registries (history/busy/queue/
// cancellation) and exposes run/dispose. Non-React factory wired with typed
// ports. The task-session binding map is shared (owned by the provider) and
// passed in, since launch/exit/taskForSession also read it.
import type { MutableRefObject } from 'react'
import type { AppState, EventType, NotifKind, TaskChatMsg } from '../../core/types'
import type { ApiMessage } from '../../master'
import { AbortRegistry } from '../../core/abort-registry'
import { runWatcherLoop } from './watcher-runner'

export interface WatcherPorts {
  stateRef: MutableRefObject<AppState>
  dispatch: (f: (s: AppState) => AppState) => void
  taskSessions: MutableRefObject<Map<string, { taskId: string; workspaceId: string }>>
  applyAgentStatus: (sid: string, task?: string, summary?: string, actionNeeded?: string) => void
  pushTaskChat: (taskId: string, role: TaskChatMsg['role'], text: string) => void
  logEvent: (type: EventType, agentId: string | null, text: string) => void
  notify: (kind: NotifKind, title: string, detail: string, agentId: string | null) => void
  fireAddonHook: (hook: 'onTaskMoved', event: Record<string, unknown>) => void
  spawnTaskSession: (taskId: string, extra?: string) => string | null
}

export interface WatcherRuntime {
  run: (taskId: string, note: string) => Promise<void>
  dispose: (taskId: string) => void
}

export function createWatcherRuntime(ports: WatcherPorts): WatcherRuntime {
  const histories = new Map<string, ApiMessage[]>()
  const busy = new Set<string>()
  const queue = new Map<string, string[]>()
  const aborts = new AbortRegistry()
  return {
    run: (taskId, note) => runWatcherLoop({ ...ports, histories, busy, queue, aborts }, taskId, note),
    dispose: (taskId) => {
      aborts.abort(taskId) // cancel any in-flight watcher turn for this task
      histories.delete(taskId)
      busy.delete(taskId)
      queue.delete(taskId)
    },
  }
}
