const SENSITIVE_PROMPT_RE = /(?:password|passphrase|private key|api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?[ _-]?token|secret|one[ _-]?time code|verification code|otp)\s*[:?]?\s*$/i

export interface TrackedTerminalSubmission {
  historyText: string
  detail?: string
  watcherText: string
}

/** Prepare a terminal submission for durable history and LLM tracking. The
 * visible prompt is checked before the Enter reaches the PTY so credentials
 * typed into password/token prompts never enter state or model context. */
export function trackedTerminalSubmission(input: string, screen: string[]): TrackedTerminalSubmission {
  const visiblePrompt = screen.filter(Boolean).slice(-4).join('\n')
  if (SENSITIVE_PROMPT_RE.test(visiblePrompt)) {
    return {
      historyText: 'Submitted sensitive terminal input',
      watcherText: '[contents redacted because the terminal was requesting a credential]',
    }
  }
  const value = input.trim().slice(0, 2000)
  if (!value) {
    return {
      historyText: 'Pressed Enter in terminal',
      watcherText: '[Enter with no captured text — this may accept the highlighted TUI option or submit shell history]',
    }
  }
  return {
    historyText: 'Submitted terminal input',
    detail: value.slice(0, 1000),
    watcherText: value,
  }
}

export function terminalSubmissionNote(sessionName: string, tracked: TrackedTerminalSubmission): string {
  return `[user terminal input] The user submitted this directly to session "${sessionName}":\n${tracked.watcherText}\n\n` +
    'Record this as user intent. Do not repeat or act on it independently; correlate the next terminal output with this submission.'
}

