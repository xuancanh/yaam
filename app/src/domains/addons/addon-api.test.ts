import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../core/types'
import { createAddonApi } from './addon-api'
import type { AddonApiCtx } from './addon-api'

function api() {
  const stateRef = { current: { crons: [], addons: [], addonStorage: {}, tasks: [] } as unknown as AppState }
  const dispatch = vi.fn((fn: (s: AppState) => AppState) => { stateRef.current = fn(stateRef.current) })
  return {
    stateRef,
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

describe('createAddonApi focusTask', () => {
  it('navigates to the board for a live task and ignores unknown/archived ids', () => {
    const h = api()
    h.stateRef.current = {
      ...h.stateRef.current,
      view: 'workspace',
      focusTaskId: null,
      tasks: [{ id: 't1', title: 'x', col: 'progress' }, { id: 't2', title: 'y', col: 'done', archived: true }],
    } as unknown as AppState

    h.value.focusTask('t1')
    expect(h.stateRef.current.view).toBe('board')
    expect(h.stateRef.current.focusTaskId).toBe('t1')

    h.stateRef.current = { ...h.stateRef.current, view: 'workspace', focusTaskId: null } as AppState
    h.value.focusTask('t2') // archived
    h.value.focusTask('nope') // unknown
    expect(h.stateRef.current.view).toBe('workspace')
    expect(h.stateRef.current.focusTaskId).toBeNull()
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
