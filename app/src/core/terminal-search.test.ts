import { describe, expect, it, vi } from 'vitest'
import { runTerminalSearch, type TerminalSearchPort } from './terminal-search'

function port(overrides: Partial<TerminalSearchPort> = {}): TerminalSearchPort {
  return {
    clearDecorations: vi.fn(),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    ...overrides,
  }
}

describe('runTerminalSearch', () => {
  it('uses synchronous selection-only search options', () => {
    const search = port()
    expect(runTerminalSearch(search, 'needle', 'next', true)).toBe(true)
    expect(search.findNext).toHaveBeenCalledWith('needle', { incremental: true })
    expect(runTerminalSearch(search, 'needle', 'prev')).toBe(true)
    expect(search.findPrevious).toHaveBeenCalledWith('needle')
  })

  it('clears the addon for an empty query', () => {
    const search = port()
    expect(runTerminalSearch(search, '', 'next')).toBe(false)
    expect(search.clearDecorations).toHaveBeenCalledOnce()
    expect(search.findNext).not.toHaveBeenCalled()
  })
})
