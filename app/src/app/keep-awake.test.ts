import { describe, expect, it } from 'vitest'
import { keepAwakeDesired } from './keep-awake'
import type { AppState } from '../core/types'

const state = (keepAwake: 'off' | 'sessions' | 'always' | undefined, agents: Partial<AppState['agents'][number]>[]) =>
  ({ settings: { keepAwake }, agents }) as unknown as Pick<AppState, 'agents' | 'settings'>

describe('keepAwakeDesired', () => {
  it('is off by default and when explicitly off', () => {
    expect(keepAwakeDesired(state(undefined, [{ status: 'running' }]))).toBe(false)
    expect(keepAwakeDesired(state('off', [{ status: 'running' }]))).toBe(false)
  })

  it('always holds regardless of session activity', () => {
    expect(keepAwakeDesired(state('always', []))).toBe(true)
  })

  it('sessions mode follows live running/needs sessions only', () => {
    expect(keepAwakeDesired(state('sessions', []))).toBe(false)
    expect(keepAwakeDesired(state('sessions', [{ status: 'idle' }]))).toBe(false)
    expect(keepAwakeDesired(state('sessions', [{ status: 'running' }]))).toBe(true)
    expect(keepAwakeDesired(state('sessions', [{ status: 'needs' }]))).toBe(true)
    // archived sessions never hold the machine awake
    expect(keepAwakeDesired(state('sessions', [{ status: 'running', archived: true }]))).toBe(false)
  })
})
