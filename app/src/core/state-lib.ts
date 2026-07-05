// Compatibility barrel. The pure helpers that used to live here now belong to
// their domains; this file re-exports them so existing `core/state-lib` imports
// keep working. Prefer importing from the domain/infrastructure module directly.
export { mkId } from '../shared/id'
export { SCHEMA_VERSION, selectSession, selectMainState } from '../infrastructure/persistence/schema'
export { fieldMatches, cronMatches, humanizeCron } from '../domains/schedules/cron'
export {
  PROMPT_RE, TUI_PROMPT_RE, QUESTION_LINE_RE, QUESTION_MARK_LINE_RE, OPTION_RE, extractOptions,
} from '../domains/session/prompt-detection'
export { taskWorkText, taskContract } from '../domains/board/task-prompt'
export {
  mkGroup, activeGroupOf, groupsFromLegacy, removeFromGroups, focusSessionIn,
} from '../domains/session/layout-state'
export { emptyScoped, scopedFromState, applyScoped, switchWorkspaceIn } from '../domains/workspace/state'
export { shQuote, buildTemplateCommand } from '../domains/schedules/template-command'
export { typeForCommand, envPrefix, spawnAgentProcess, wait, KEYMAP, sendLineToSession } from '../domains/session/command'
