import { describe, expect, it } from 'vitest'
import { reducer, withActiveGroup, inferLegacyTerminalShell } from './state-helpers'
import type { AppState, TabGroup } from '../types'

describe('reducer', () => {
  it('applies the updater function to state', () => {
    const s = { a: 1 } as unknown as AppState
    expect(reducer(s, x => ({ ...x, a: 2 } as unknown as AppState))).toEqual({ a: 2 })
  })
})

describe('withActiveGroup', () => {
  const group = (id: string): TabGroup => ({ id, slots: [], stacked: false, activePane: 0, maximizedPane: null, splits: { row: 0.5, cols: [0.5, 0.5] } })
  it('applies the change to the active group only', () => {
    const s = { activeGroup: 'g1', groups: [group('g1'), group('g2')] } as unknown as AppState
    const next = withActiveGroup(s, g => ({ ...g, stacked: true }))
    expect(next.groups.find(g => g.id === 'g1')?.stacked).toBe(true)
    expect(next.groups.find(g => g.id === 'g2')?.stacked).toBe(false)
  })
  it('is a no-op when there is no active group', () => {
    const s = { activeGroup: null, groups: [] } as unknown as AppState
    expect(withActiveGroup(s, g => ({ ...g, stacked: true }))).toBe(s)
  })
})

describe('inferLegacyTerminalShell', () => {
  it('recognizes bare login/interactive shell commands', () => {
    expect(inferLegacyTerminalShell('zsh -i')).toBe('zsh')
    expect(inferLegacyTerminalShell('bash -l -i')).toBe('bash')
    expect(inferLegacyTerminalShell('fish')).toBe('fish')
  })
  it('rejects non-shell or argument-bearing commands', () => {
    expect(inferLegacyTerminalShell('claude -p "hi"')).toBeUndefined()
    expect(inferLegacyTerminalShell('zsh -c "echo hi"')).toBeUndefined()
    expect(inferLegacyTerminalShell(undefined)).toBeUndefined()
  })
})
