// The watcher-note protocol: a tiny tagging convention on the strings fed to a
// task's watcher so its note queue can tell routine progress (collapsible — only
// the newest screen matters) from discrete events (prompts, exits, user
// messages) that must each be delivered. Kept as a dependency-free leaf so both
// the settle engine (producer) and the watcher runner (consumer) can import it.

/** Prefix marking a routine "session produced stable output" progress note. */
export const NOTE_PROGRESS = '[progress]'

/** Whether a note is a routine progress update (vs. a discrete event). */
export function isProgressNote(note: string): boolean {
  return note.startsWith(NOTE_PROGRESS)
}

/**
 * Add `note` to a watcher's pending-note queue. A progress note SUPERSEDES any
 * earlier undelivered progress note — successive settles produce overlapping
 * screen tails, so only the latest is worth sending; concatenating them all
 * (the old behavior) just fed the LLM redundant, confusing near-duplicates.
 * Event notes always accumulate in order. Mirrors the session monitor's
 * latest-wins queue. Pure — returns the next queue.
 */
export function enqueueWatcherNote(queue: string[], note: string): string[] {
  const kept = isProgressNote(note) ? queue.filter(n => !isProgressNote(n)) : queue
  return kept.concat([note])
}
