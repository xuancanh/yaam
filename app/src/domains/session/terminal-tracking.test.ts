import { describe, expect, it } from 'vitest'
import { terminalSubmissionNote, trackedTerminalSubmission } from './terminal-tracking'

describe('trackedTerminalSubmission', () => {
  it('keeps submitted text as bounded history and watcher context', () => {
    const tracked = trackedTerminalSubmission('  fix auth and run tests  ', ['Ready'])
    expect(tracked).toEqual({
      historyText: 'Submitted terminal input',
      detail: 'fix auth and run tests',
      watcherText: 'fix auth and run tests',
    })
    expect(terminalSubmissionNote('Codex', tracked)).toContain('[user terminal input]')
  })

  it('describes an empty Enter without inventing typed text', () => {
    expect(trackedTerminalSubmission('', ['Select an option']).historyText).toBe('Pressed Enter in terminal')
  })

  it('never retains input entered at a credential prompt', () => {
    const tracked = trackedTerminalSubmission('super-secret', ['GitHub password:'])
    expect(tracked.historyText).toBe('Submitted sensitive terminal input')
    expect(tracked.detail).toBeUndefined()
    expect(tracked.watcherText).not.toContain('super-secret')
  })
})

