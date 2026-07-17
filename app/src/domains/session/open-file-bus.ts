// Tiny module-level bridge: the terminal asks the session's Files panel to
// open a ctrl/cmd+clicked path. Two hops because the panel may be closed —
// the Pane subscribes to make the FILES panel visible, the FilesPane (once
// mounted) consumes the path. A pending slot covers the mount gap.
const viewers = new Map<string, (path: string) => void>()
const openers = new Map<string, () => void>()
const pending = new Map<string, string>()

/** Pane subscribes for its agent: make the FILES panel visible. */
export function onEnsureFilesPanel(agentId: string, cb: () => void): () => void {
  openers.set(agentId, cb)
  return () => {
    if (openers.get(agentId) === cb) openers.delete(agentId)
  }
}

/** FilesPane subscribes for its agent; a path parked while it was unmounted
 *  is delivered immediately. Returns the unsubscribe. */
export function onOpenFileRequest(agentId: string, cb: (path: string) => void): () => void {
  viewers.set(agentId, cb)
  const parked = pending.get(agentId)
  if (parked !== undefined) {
    pending.delete(agentId)
    cb(parked)
  }
  return () => {
    if (viewers.get(agentId) === cb) viewers.delete(agentId)
  }
}

/** Terminal link activation: open `path` in the session's file viewer. */
export function requestOpenFile(agentId: string, path: string) {
  openers.get(agentId)?.()
  const viewer = viewers.get(agentId)
  if (viewer) viewer(path)
  else pending.set(agentId, path)
}
