// Tiny module-level bridge: the file explorer (FilesPane) asks the chat pane
// hosting the same agent to attach a file. Keeps the two components decoupled
// — FilesPane emits a path, the mounted ChatPane loads and chips it.
const subs = new Map<string, (path: string) => void>()

/** ChatPane subscribes for its agent; returns the unsubscribe. */
export function onAttachRequest(agentId: string, cb: (path: string) => void): () => void {
  subs.set(agentId, cb)
  return () => {
    if (subs.get(agentId) === cb) subs.delete(agentId)
  }
}

/** True when a chat pane for this agent is mounted and accepted the request. */
export function requestAttach(agentId: string, path: string): boolean {
  const cb = subs.get(agentId)
  if (!cb) return false
  cb(path)
  return true
}

// Second channel: the agent home page asks a mounted chat pane to embed one
// of the agent's mini apps in its artifact panel (sandboxed side-by-side).
import type { AgentApp } from '../../core/types'

const appSubs = new Map<string, (app: AgentApp) => void>()

/** ChatPane subscribes for its conversation id; returns the unsubscribe. */
export function onAppEmbed(agentId: string, cb: (app: AgentApp) => void): () => void {
  appSubs.set(agentId, cb)
  return () => {
    if (appSubs.get(agentId) === cb) appSubs.delete(agentId)
  }
}

/** True when a chat pane for this conversation accepted the embed. */
export function requestAppEmbed(agentId: string, app: AgentApp): boolean {
  const cb = appSubs.get(agentId)
  if (!cb) return false
  cb(app)
  return true
}
