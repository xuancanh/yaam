// Pure state plumbing shared by the provider: the reducer entry point, active
// tab-group updates, and legacy-shape inference. No React, no side effects.
import { SHELLS } from '../core/data'
import type { AppState, TabGroup } from '../core/types'

export type Updater = (s: AppState) => AppState

/** Apply a pure state updater; side effects must remain outside this reducer. */
export function reducer(s: AppState, f: Updater): AppState {
  return f(s)
}

/** Apply a change to the active tab group (no-op when none is active). */
export function withActiveGroup(s: AppState, f: (g: TabGroup) => TabGroup): AppState {
  if (!s.activeGroup || !s.groups.some(g => g.id === s.activeGroup)) return s
  return { ...s, groups: s.groups.map(g => (g.id === s.activeGroup ? f(g) : g)) }
}

/** Recognize the exact plain-terminal commands written by releases before terminalShell persisted. */
export function inferLegacyTerminalShell(command?: string): string | undefined {
  const parts = command?.trim().split(/\s+/) ?? []
  const shell = SHELLS.find(candidate => candidate === parts[0])
  return shell && parts.slice(1).every(arg => /^-[il]+$/.test(arg)) ? shell : undefined
}
