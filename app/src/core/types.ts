// Compatibility barrel. Entity/record types live in core/entities; each domain's
// AppState slice lives in its own domain folder. This module re-exports both and
// composes the slices into the root AppState, so existing `from '../core/types'`
// imports keep working through the store-domain migration.
export * from './entities'

import type { BootStatus } from './entities'
import type { WorkspaceSlice } from '../domains/workspace/slice'
import type { SessionSlice } from '../domains/session/slice'
import type { BoardSlice } from '../domains/board/slice'
import type { ScheduleSlice } from '../domains/schedules/slice'
import type { MasterSlice } from '../domains/master/slice'
import type { AddonSlice } from '../domains/addons/slice'
import type { SettingsSlice } from '../domains/settings/slice'
import type { ActivitySlice } from '../domains/activity/slice'
import type { ChatSlice } from '../domains/chat/slice'
import type { ShellUiSlice } from '../domains/shell/slice'

export type {
  WorkspaceSlice, SessionSlice, BoardSlice, ScheduleSlice, MasterSlice,
  AddonSlice, SettingsSlice, ActivitySlice, ChatSlice, ShellUiSlice,
}

/** Root application state: every domain slice plus the transient boot status.
 *  Each field lives in exactly one slice; tsc enforces exhaustiveness at use sites. */
export interface AppState extends
  WorkspaceSlice, SessionSlice, BoardSlice, ScheduleSlice, MasterSlice,
  AddonSlice, SettingsSlice, ActivitySlice, ChatSlice, ShellUiSlice {
  /** transient runtime restoration lifecycle (never persisted). Dependent
   *  runtimes (scheduler, integrations) gate their work on 'ready'. */
  bootStatus: BootStatus
}
