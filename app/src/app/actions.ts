// The application-wide action contract is *composed* from each domain's own
// public action interface (dependency points app -> domains, not the reverse).
// `ProviderActions` holds the session/master/review actions that are still
// defined inline in the provider and have no domain module yet; they move to
// their domains as those are extracted (see the progress-review plan).
import type { ShellActions } from '../domains/shell/actions'
import type { SettingsActions } from '../domains/settings/actions'
import type { BoardActions } from '../domains/board/actions'
import type { SchedulesActions } from '../domains/schedules/actions'
import type { ChatActions } from '../domains/chat/actions'
import type { AddonsActions } from '../domains/addons/actions'
import type { WorkspaceActions } from '../domains/workspace/actions'
import type { SessionLayoutActions } from '../domains/session/layout-actions'
import type { SessionConfigActions } from '../domains/session/config-actions'
import type { SessionPromptActions } from '../domains/session/prompt-actions'
import type { MasterActions } from '../domains/master/actions'

/** Session lifecycle actions still defined inline in the provider (they drive the
 *  PTY/terminal lifecycle). The last group pending extraction into a session
 *  controller. */
export interface ProviderActions {
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  deleteSession: (id: string) => void
  resume: (id: string) => void
  newRealSession: (command: string, cwd: string, terminalShell?: string) => void
  sendInput: (id: string, text: string) => void
  stopSession: (id: string) => void
}

export type ConductorActions =
  ShellActions & SettingsActions & BoardActions & SchedulesActions &
  ChatActions & AddonsActions & WorkspaceActions & SessionLayoutActions &
  SessionConfigActions & SessionPromptActions & MasterActions & ProviderActions

// Re-export the domain action interfaces so the composition and consumers can
// name individual slices without reaching into each domain module.
export type {
  ShellActions, SettingsActions, BoardActions, SchedulesActions,
  ChatActions, AddonsActions, WorkspaceActions, SessionLayoutActions, SessionConfigActions, SessionPromptActions, MasterActions,
}
