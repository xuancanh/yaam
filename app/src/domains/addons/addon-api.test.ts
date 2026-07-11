import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../core/types'
import { createAddonApi } from './addon-api'
import type { AddonApiCtx } from './addon-api'

function api() {
  const dispatch = vi.fn()
  const stateRef = { current: { crons: [], addons: [] } as unknown as AppState }
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
