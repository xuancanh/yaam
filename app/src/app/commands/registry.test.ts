import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry } from './registry'
import { createDefaultPolicy } from './policy'
import { CommandDenied, approvalKey, type Actor, type CommandDef } from './types'
import type { AddonPermission } from '../../core/types'

const sendCmd = (handler = vi.fn(async (i: { id: string; text: string }) => `sent ${i.text} to ${i.id}`)): CommandDef<{ id: string; text: string }, string> => ({
  name: 'send_to_session',
  capability: 'sessions:send',
  validate: i => { if (!i.id) throw new Error('id required') },
  handler,
})

function make(grants: Record<string, AddonPermission[]> = {}) {
  const policy = createDefaultPolicy(id => grants[id] ?? [])
  return createCommandRegistry(policy)
}

describe('command registry + default policy', () => {
  it('runs a command for the user and returns its result', async () => {
    const reg = make()
    reg.register(sendCmd())
    const out = await reg.execute<string>('send_to_session', { id: 's1', text: 'hi' }, { actor: { kind: 'user' } })
    expect(out).toBe('sent hi to s1')
    expect(reg.audit.at(-1)).toMatchObject({ command: 'send_to_session', decision: 'allow' })
  })

  it('validates input before policy/handler', async () => {
    const reg = make()
    const handler = vi.fn(async () => 'x')
    reg.register(sendCmd(handler))
    await expect(reg.execute('send_to_session', { id: '', text: 'hi' }, { actor: { kind: 'user' } })).rejects.toThrow('id required')
    expect(handler).not.toHaveBeenCalled()
  })

  it('allows an addon only for a granted capability', async () => {
    const reg = make({ ad1: ['sessions:send'], ad2: ['ui'] })
    reg.register(sendCmd())
    const actor1: Actor = { kind: 'addon', addonId: 'ad1' }
    await expect(reg.execute('send_to_session', { id: 's1', text: 'hi' }, { actor: actor1 })).resolves.toBe('sent hi to s1')

    const actor2: Actor = { kind: 'addon', addonId: 'ad2' } // lacks sessions:send
    await expect(reg.execute('send_to_session', { id: 's1', text: 'hi' }, { actor: actor2 })).rejects.toBeInstanceOf(CommandDenied)
    expect(reg.audit.at(-1)).toMatchObject({ decision: 'deny' })
  })

  it('consumes a one-shot approval for an ask decision', async () => {
    // a policy that asks for a specific command
    const reg = createCommandRegistry((_actor, cmd) => (cmd.name === 'danger' ? 'ask' : 'allow'))
    const handler = vi.fn(async () => 'done')
    reg.register({ name: 'danger', capability: 'sessions:send', handler })
    const actor: Actor = { kind: 'master' }

    // without approval → denied
    await expect(reg.execute('danger', {}, { actor })).rejects.toThrow(/approval/)
    expect(handler).not.toHaveBeenCalled()

    // with a matching one-shot approval → runs once, approval consumed
    const approvals = new Set([approvalKey(actor, 'danger')])
    await expect(reg.execute('danger', {}, { actor, approvals })).resolves.toBe('done')
    expect(approvals.size).toBe(0)
    // a second attempt is denied again (one-shot)
    await expect(reg.execute('danger', {}, { actor, approvals })).rejects.toThrow(/approval/)
  })

  it('rejects an unknown command', async () => {
    const reg = make()
    await expect(reg.execute('nope', {}, { actor: { kind: 'user' } })).rejects.toBeInstanceOf(CommandDenied)
  })
})
