import { describe, expect, it, vi } from 'vitest'
import type { AddonApi } from './addons'
import type { AppState } from './types'

const sandboxRun = vi.fn()
vi.mock('../domains/addons/sandbox', () => ({
  addonSandbox: () => ({ run: sandboxRun }),
}))

import { execAddonHook } from './addons'

describe('addon hook scheduling', () => {
  it('serializes overlapping hooks for the same addon', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    sandboxRun.mockImplementation(async (_source: string, event: { n: number }) => {
      order.push(`start-${event.n}`)
      if (event.n === 1) await blocked
      order.push(`end-${event.n}`)
    })
    const state = {
      addons: [{ id: 'workflow', name: 'Workflow', enabled: true, hooks: { onTaskMoved: 'handler' } }],
    } as unknown as AppState
    const api = { logEvent: vi.fn() } as unknown as AddonApi

    const first = execAddonHook(state, 'onTaskMoved', { n: 1 }, () => api)
    await vi.waitFor(() => expect(order).toEqual(['start-1']))
    const second = execAddonHook(state, 'onTaskMoved', { n: 2 }, () => api)
    await Promise.resolve()
    expect(order).toEqual(['start-1'])

    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })
})
