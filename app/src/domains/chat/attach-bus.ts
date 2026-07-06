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
