import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../core/types'
import { createAddonApi } from './addon-api'
import type { AddonApiCtx } from './addon-api'

function api() {
  const stateRef = { current: { crons: [], addons: [], addonStorage: {} } as unknown as AppState }
  const dispatch = vi.fn((fn: (s: AppState) => AppState) => { stateRef.current = fn(stateRef.current) })
  return {
    dispatch,
    value: createAddonApi({ stateRef, dispatch } as unknown as AddonApiCtx, 'addon'),
  }
}

describe('createAddonApi schedules', () => {
  it('refuses impossible five-field expressions before persisting them', () => {
    const h = api()

    expect(h.value.schedules.add({ name: 'dead-loop', schedule: '99 25 * * *' })).toMatch(/valid 5-field cron/)
    expect(h.dispatch).not.toHaveBeenCalled()
  })
})

describe('createAddonApi storage', () => {
  it('bounds keys, individual values, and total persisted storage', () => {
    const h = api()

    expect(() => h.value.storage.set('', 'x')).toThrow(/key/)
    expect(() => h.value.storage.set('huge', 'x'.repeat(256 * 1024 + 1))).toThrow(/256 KB/)
    for (let i = 0; i < 4; i++) h.value.storage.set(`chunk-${i}`, 'x'.repeat(250_000))
    expect(() => h.value.storage.set('overflow', 'x'.repeat(100_000))).toThrow(/1 MB/)
    expect(h.value.storage.list()).toHaveLength(4)
  })
})
