import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../core/types'
import { createAddonAgentRuntime } from './agent-runtime'

const mocks = vi.hoisted(() => ({ runTurn: vi.fn(async () => 'acted') }))

vi.mock('../../master', async importOriginal => ({
  ...await importOriginal<typeof import('../../master')>(),
  buildCfg: vi.fn(() => ({})),
  hasCreds: vi.fn(() => true),
}))

vi.mock('./addon-agent', () => ({ runAddonAgentTurn: mocks.runTurn }))

function runtime(granted: string[]) {
  const stateRef = { current: {
    settings: { masterEnabled: true },
    addons: [{
      id: 'addon', name: 'Agent addon', enabled: true, granted,
      agent: { system: 'watch things' },
    }],
  } as unknown as AppState }
  return createAddonAgentRuntime({
    stateRef,
    logEvent: vi.fn(),
    makeAddonApi: vi.fn(() => ({} as never)),
  })
}

describe('createAddonAgentRuntime', () => {
  it('does not spend an LLM turn without the dangerous agent grant', async () => {
    mocks.runTurn.mockClear()

    await expect(runtime([]).run('addon', 'scheduled wake')).resolves.toMatch(/not granted/)
    expect(mocks.runTurn).not.toHaveBeenCalled()
  })

  it('runs after the agent capability is explicitly granted', async () => {
    mocks.runTurn.mockClear()

    await expect(runtime(['agent']).run('addon', 'scheduled wake')).resolves.toBe('acted')
    expect(mocks.runTurn).toHaveBeenCalledOnce()
  })
})
