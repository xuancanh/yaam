// Tiny bus letting outsiders (the sidebar's escalation cards) put a session on
// the Mission Control stage. Lives apart from MissionControl.tsx so the eager
// sidebar never drags the lazy-loaded deck chunk into the main bundle.
let stageHandler: ((id: string) => void) | null = null

/** MissionControl registers its pin setter while mounted. */
export function onMissionStage(fn: (id: string) => void): () => void {
  stageHandler = fn
  return () => { if (stageHandler === fn) stageHandler = null }
}

/** Stage a session on the deck (no-op when Mission Control is not mounted). */
export function requestMissionStage(id: string): void {
  stageHandler?.(id)
}
