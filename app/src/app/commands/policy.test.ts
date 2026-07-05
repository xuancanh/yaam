import { describe, expect, it } from 'vitest'
import { createDefaultPolicy } from './policy'
import type { Actor, Capability, CommandDef } from './types'
import type { AddonPermission } from '../../core/types'

// Exhaustive characterization of the security boundary: the default policy is the
// one gate every actor's commands pass through. Tested as a pure function so the
// full permission matrix is asserted directly, independent of the registry.
const cmd = (capability: Capability): CommandDef =>
  ({ name: 'x', capability, handler: async () => undefined }) as unknown as CommandDef
const NO_INPUT = {}

describe('createDefaultPolicy — permission matrix', () => {
  const grants: Record<string, AddonPermission[]> = {
    granted: ['sessions:send'],
    otherCap: ['tasks'],
    none: [],
  }
  const policy = createDefaultPolicy(id => grants[id] ?? [])

  // The trusted actors are allowed at this layer regardless of capability; their
  // own per-action gates live in their flows, not here.
  it.each<Actor['kind']>(['user', 'master', 'watcher', 'chat'])(
    'allows the trusted actor %s for any capability',
    kind => {
      const actor = { kind } as Actor
      expect(policy(actor, cmd('sessions:send'), NO_INPUT)).toBe('allow')
      expect(policy(actor, cmd('tasks'), NO_INPUT)).toBe('allow')
    },
  )

  it('allows an addon only for a capability it was granted', () => {
    expect(policy({ kind: 'addon', addonId: 'granted' }, cmd('sessions:send'), NO_INPUT)).toBe('allow')
  })

  it('denies an addon for a capability it was not granted', () => {
    // granted a different capability than the one requested
    expect(policy({ kind: 'addon', addonId: 'otherCap' }, cmd('sessions:send'), NO_INPUT)).toBe('deny')
  })

  it('denies an addon with no grants', () => {
    expect(policy({ kind: 'addon', addonId: 'none' }, cmd('sessions:send'), NO_INPUT)).toBe('deny')
  })

  it('denies an unknown/disabled addon (no grants resolved)', () => {
    expect(policy({ kind: 'addon', addonId: 'ghost' }, cmd('tasks'), NO_INPUT)).toBe('deny')
  })
})
