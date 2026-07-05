import { describe, expect, it } from 'vitest'
import { classifyExit } from './exit'

const base = { code: 0, userStopped: false, ephemeral: false, autoArchive: false, hasTask: false }

describe('classifyExit', () => {
  it('a user stop is never a failure and stays quiet', () => {
    const r = classifyExit({ ...base, userStopped: true, code: 137 })
    expect(r).toMatchObject({ outcome: 'stopped', failed: false, notify: false, reportToMonitor: false, autoArchive: false })
  })

  it('a clean one-shot exit is a completion (notifies, reports, no fail)', () => {
    const r = classifyExit({ ...base, ephemeral: true, code: 0 })
    expect(r).toMatchObject({ outcome: 'completed', failed: false, notify: true, reportToMonitor: true })
  })

  it('a failed one-shot exit is a failure', () => {
    const r = classifyExit({ ...base, ephemeral: true, code: 1 })
    expect(r).toMatchObject({ outcome: 'failed', failed: true, notify: true })
    expect(r.autoArchive).toBe(false) // never auto-archive a failure
  })

  it('a clean interactive exit is "exited", not "completed"', () => {
    expect(classifyExit({ ...base, code: 0 }).outcome).toBe('exited')
    expect(classifyExit({ ...base, code: null }).outcome).toBe('exited') // null = no code
  })

  it('a failed interactive exit is a failure', () => {
    expect(classifyExit({ ...base, code: 2 })).toMatchObject({ outcome: 'failed', failed: true })
  })

  it('auto-archives only a clean one-shot with the flag set', () => {
    expect(classifyExit({ ...base, ephemeral: true, code: 0, autoArchive: true }).autoArchive).toBe(true)
    expect(classifyExit({ ...base, ephemeral: true, code: 1, autoArchive: true }).autoArchive).toBe(false)
    expect(classifyExit({ ...base, ephemeral: false, code: 0, autoArchive: true }).autoArchive).toBe(false)
  })

  it('does not report to the monitor when a task owns the session', () => {
    expect(classifyExit({ ...base, ephemeral: true, code: 0, hasTask: true }).reportToMonitor).toBe(false)
  })
})
