// Pure classification of a session's process exit. The provider's onSessionExit
// handler fans an exit out to session state, the board, activity, notifications,
// addon hooks, the task watcher, and the monitor — but the DECISIONS (was it a
// user stop? a failure? should it notify / auto-archive / report to the monitor?)
// are pure and belong here so they're unit-testable, independent of that fan-out.
export type ExitOutcome = 'stopped' | 'failed' | 'completed' | 'exited'

export interface SessionExit {
  /** stopped = user pressed ■; failed = non-zero exit; completed = clean one-shot;
   *  exited = clean exit of an interactive session. */
  outcome: ExitOutcome
  /** error status for the card/session (a user stop is never a failure). */
  failed: boolean
  userStopped: boolean
  /** surface a desktop notification (everything except a user stop). */
  notify: boolean
  /** hand the outcome to the generic session monitor (non-task, non-stopped). */
  reportToMonitor: boolean
  /** tidy the pane away after a delay (clean one-shot with auto-archive on). */
  autoArchive: boolean
}

export function classifyExit(input: {
  code: number | null
  userStopped: boolean
  ephemeral: boolean
  autoArchive: boolean
  hasTask: boolean
}): SessionExit {
  const { userStopped, code, ephemeral, hasTask } = input
  // a non-zero, non-null exit code is a failure — unless the user stopped it
  const failed = !userStopped && code !== 0 && code !== null
  const outcome: ExitOutcome = userStopped ? 'stopped'
    : failed ? 'failed'
    : ephemeral ? 'completed'
    : 'exited'
  return {
    outcome,
    failed,
    userStopped,
    notify: !userStopped,
    reportToMonitor: !userStopped && !hasTask,
    autoArchive: !userStopped && ephemeral && !failed && input.autoArchive,
  }
}
