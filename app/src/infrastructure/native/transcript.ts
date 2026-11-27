// Native bridge for CLI transcript tailing: the Rust watcher polls a session's
// JSONL transcript and forwards complete new lines as `transcript-lines`
// events. Browser build: no-ops.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from './base'

export interface TranscriptLinesEvent {
  /** YAAM session id the watcher was registered under */
  agent: string
  /** complete new JSONL lines, oldest first */
  lines: string[]
  /** history read back when the watch started, not new activity */
  backfill?: boolean
}

/** Start (or replace) the transcript watcher for a session. `fromStart` streams
 *  the whole file (fresh session); otherwise an existing file is tailed from
 *  its end (resume). Best-effort: failures are swallowed — transcripts are a
 *  supplementary signal. */
export async function transcriptWatch(agent: string, kind: string, cwd: string, sessionId: string, fromStart: boolean, backfill = false): Promise<void> {
  if (!isTauri) return
  await invoke('transcript_watch', { agent, kind, cwd, sessionId, fromStart, backfill }).catch(() => {})
}

/** Whether a Claude Code conversation is still on disk (Claude deletes old
 *  transcripts); true when unknown, so callers fall back to a normal resume. */
export async function claudeTranscriptExists(cwd: string, sessionId: string): Promise<boolean> {
  if (!isTauri) return true
  return await invoke<boolean>('claude_transcript_exists', { cwd, sessionId }).catch(() => true)
}

/** Stop a session's transcript watcher. */
export async function transcriptUnwatch(agent: string): Promise<void> {
  if (!isTauri) return
  await invoke('transcript_unwatch', { agent }).catch(() => {})
}

/** A CLI session found in an on-disk store, adoptable into YAAM. */
export interface DiscoveredSession {
  kind: string
  sessionId: string
  cwd: string | null
  mtimeMs: number
}

/** List recent CLI sessions from the claude/codex stores, newest first. */
export async function discoverSessions(sinceMs: number): Promise<DiscoveredSession[]> {
  if (!isTauri) return []
  try {
    return await invoke<DiscoveredSession[]>('discover_sessions', { sinceMs })
  } catch {
    return []
  }
}

/** Subscribe to forwarded transcript lines; returns an unsubscribe function. */
export function onTranscriptLines(cb: (e: TranscriptLinesEvent) => void): () => void {
  if (!isTauri) return () => {}
  let alive = true
  let unlisten = () => {}
  listen<TranscriptLinesEvent>('transcript-lines', e => cb(e.payload)).then(fn => {
    if (alive) unlisten = fn
    else fn()
  })
  return () => { alive = false; unlisten() }
}
