import { describe, expect, it } from 'vitest'
import { DEFAULT_QUICK_PROMPTS, groupPeers, promptsFor, quickPromptsOf } from './quick-prompts'
import { fillPrompt, selectionPrompt, taskFromSelection } from './prompt-compose'
import type { AppState } from '../../core/types'

describe('quick prompts', () => {
  it('falls back to defaults until the user saves a list', () => {
    expect(quickPromptsOf({ settings: {} } as AppState)).toBe(DEFAULT_QUICK_PROMPTS)
    expect(quickPromptsOf({ settings: { quickPrompts: [] } } as unknown as AppState)).toEqual([])
  })
  it('scopes folder prompts to sessions inside that folder', () => {
    const list = [{ id: 'a', label: 'A', text: 'a' }, { id: 'b', label: 'B', text: 'b', folder: '~/work/api/' }]
    expect(promptsFor(list, '~/work/api/src').map(p => p.id)).toEqual(['a', 'b'])
    expect(promptsFor(list, '~/work/apix').map(p => p.id)).toEqual(['a'])
    expect(promptsFor(list, undefined).map(p => p.id)).toEqual(['a'])
  })
  it('finds live group peers for broadcast', () => {
    const s = {
      groups: [{ slots: ['x', 'y', null, 'z'] }],
      agents: [{ id: 'x', status: 'running' }, { id: 'y', status: 'running' }, { id: 'z', status: 'idle' }],
    } as unknown as AppState
    expect(groupPeers(s, 'x')).toEqual(['y'])
  })
})

describe('prompt composition', () => {
  it('fills {selection} and refuses when there is none', () => {
    expect(fillPrompt('Explain:{selection}', { selection: '\x1b[31mboom\x1b[0m  ' })).toBe('Explain:\n```\nboom\n```')
    expect(fillPrompt('Explain:{selection}', {})).toBeNull()
    expect(fillPrompt('plain', {})).toBe('plain')
  })
  it('labels handed-over output with its source session', () => {
    expect(selectionPrompt('err', 'fix it', { name: 'api', same: false })).toMatch(/^fix it\n\nOutput from the "api" session's terminal:/)
    expect(selectionPrompt('err', '', { name: 'api', same: true })).toMatch(/from this terminal/)
  })
  it('titles a task after the error line', () => {
    const t = taskFromSelection('$ npm test\n  ✓ ok\n  FAIL src/a.test.ts\nError: expected 1', { name: 's', cwd: '/p' })
    expect(t.title).toBe('Fix: FAIL src/a.test.ts')
    expect(t.cwd).toBe('/p')
  })
})
