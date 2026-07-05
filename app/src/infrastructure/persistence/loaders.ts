// Load the persisted snapshot off disk, recovering the main partition from its
// backup when the primary is corrupt. Returns data + a `usedBackup` flag so the
// caller owns any user-facing toast; no dispatch here.
import type { Agent, PersistedState } from '../../core/types'
import * as native from '../../core/native'

export interface LoadedSnapshot {
  merged: Partial<PersistedState>
  /** true when the main partition was recovered from its .bak copy. */
  usedBackup: boolean
}

// Parse the main partition, recovering from its backup if the primary is
// unparseable (rethrows if the backup is bad too).
async function parseMain(): Promise<{ main: Partial<PersistedState>; usedBackup: boolean }> {
  const raw = await native.loadStateFile()
  if (!raw) return { main: {}, usedBackup: false }
  try {
    return { main: JSON.parse(raw) as Partial<PersistedState>, usedBackup: false }
  } catch (e) {
    console.error('[yaam] main state unreadable — trying backup:', e)
    const bak = await native.loadStateBackup()
    if (!bak) throw e
    return { main: JSON.parse(bak) as Partial<PersistedState>, usedBackup: true }
  }
}

// Load sessions: prefer one-file-per-session, then the legacy single
// sessions.json partition, then the even older agents embedded in main.
// A bad/absent source just means fewer restored sessions.
async function parseSessionAgents(): Promise<Agent[] | undefined> {
  try {
    const files = await native.loadSessions()
    if (files.length) {
      const agents: Agent[] = []
      for (const raw of files) {
        try {
          const parsed = JSON.parse(raw) as { agent?: Agent }
          if (parsed.agent) agents.push(parsed.agent)
        } catch (e) {
          console.error('[yaam] a session file was unreadable — skipping:', e)
        }
      }
      if (agents.length) return agents
    }
  } catch (e) {
    console.error('[yaam] loading session files failed:', e)
  }
  try {
    const raw = await native.loadPartition('sessions')
    if (raw) return (JSON.parse(raw) as Partial<PersistedState>).agents
  } catch (e) {
    console.error('[yaam] legacy sessions partition unreadable — ignoring:', e)
  }
  return undefined
}

export async function loadSnapshot(): Promise<LoadedSnapshot> {
  const [{ main, usedBackup }, sessionAgents] = await Promise.all([parseMain(), parseSessionAgents()])
  // agents live in the sessions partition now; legacy saves embed them in main
  const merged: Partial<PersistedState> = { ...main, agents: sessionAgents ?? main.agents }
  return { merged, usedBackup }
}
