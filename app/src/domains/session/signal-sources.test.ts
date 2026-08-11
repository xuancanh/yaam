import { describe, expect, it, beforeEach } from 'vitest'
import {
  STRUCTURED_FRESH_MS, dropStructuredSignals, hasAuthoritativeSignals,
  markStructuredSignal, resetStructuredSignals, structuredSourceOf,
} from './signal-sources'

beforeEach(() => resetStructuredSignals())

describe('signal-sources', () => {
  it('coverage is evidence-based and decays', () => {
    const t0 = 1_000_000
    markStructuredSignal('a1', 'hooks', t0)
    expect(structuredSourceOf('a1', t0 + 1000)).toBe('hooks')
    expect(hasAuthoritativeSignals({ id: 'a1' }, t0 + 1000)).toBe(true)
    // stale events no longer suppress the scanner
    expect(structuredSourceOf('a1', t0 + STRUCTURED_FRESH_MS + 1)).toBeUndefined()
    expect(hasAuthoritativeSignals({ id: 'a1' }, t0 + STRUCTURED_FRESH_MS + 1)).toBe(false)
  })

  it('acp sessions are always authoritative — there is no TUI to scan', () => {
    expect(hasAuthoritativeSignals({ id: 'x', acp: true })).toBe(true)
    expect(hasAuthoritativeSignals({ id: 'x' })).toBe(false)
  })

  it('drop forgets one session', () => {
    markStructuredSignal('a1', 'opencode-bus')
    dropStructuredSignals('a1')
    expect(structuredSourceOf('a1')).toBeUndefined()
  })
})
