import { describe, expect, it } from 'vitest'
import { calibrationNote, harnessStats, recordDecision, resolveDecision } from './harness-stats'
import type { HarnessDecision } from '../../core/types'

const mk = (over: Partial<HarnessDecision>): HarnessDecision =>
  ({ id: 'd1', at: 1, role: 'monitor', kind: 'suggestion', text: 't', ...over })

describe('recordDecision / resolveDecision', () => {
  it('prepends pending decisions and resolves the newest matching one', () => {
    let log = recordDecision([], { role: 'monitor', kind: 'suggestion', agentId: 'a1', text: 'Retry' })
    log = recordDecision(log, { role: 'monitor', kind: 'suggestion', agentId: 'a1', text: 'Skip' })
    log = resolveDecision(log, { role: 'monitor', agentId: 'a1' }, 'accepted', 'Skip')
    expect(log[0].outcome).toBe('accepted')
    expect(log[0].choice).toBe('Skip')
    expect(log[1].outcome).toBeUndefined()
  })
  it('is a no-op when nothing pending matches', () => {
    const log = [mk({ outcome: 'accepted' })]
    expect(resolveDecision(log, { agentId: 'zz' }, 'dismissed')).toEqual(log)
  })
})

describe('harnessStats / calibrationNote', () => {
  it('aggregates per role and withholds precision below 3 resolutions', () => {
    const log = [
      mk({ id: '1', outcome: 'accepted' }),
      mk({ id: '2', outcome: 'dismissed' }),
      mk({ id: '3' }),
      mk({ id: '4', role: 'watcher', outcome: 'accepted' }),
    ]
    const s = harnessStats(log)
    expect(s.monitor).toMatchObject({ shown: 3, accepted: 1, dismissed: 1, pending: 1, precision: null })
    expect(s.watcher.precision).toBeNull()
  })
  it('emits a calibration note once ≥5 resolutions exist, matching precision', () => {
    const low = Array.from({ length: 6 }, (_, i) => mk({ id: `l${i}`, outcome: i < 1 ? 'accepted' : 'dismissed' }))
    expect(calibrationNote(low, 'monitor')).toContain('be more conservative')
    const high = Array.from({ length: 6 }, (_, i) => mk({ id: `h${i}`, outcome: i < 6 ? 'accepted' : 'dismissed' }))
    expect(calibrationNote(high, 'monitor')).toContain('reliable')
    expect(calibrationNote(high.slice(0, 3), 'monitor')).toBe('')
  })
})
