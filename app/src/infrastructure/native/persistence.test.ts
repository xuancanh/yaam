// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }))
vi.mock('./base', () => ({ isTauri: true }))

import { invoke } from '@tauri-apps/api/core'
import { saveSession, removeSession } from './persistence'

describe('native persistence session chains', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('orders removeSession after an in-flight save for the same id', async () => {
    let resolveSave!: () => void
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'save_session') return new Promise<void>(r => { resolveSave = r })
      return Promise.resolve() as Promise<never>
    })

    const saveP = saveSession('rel14-a', '{"v":1}')
    await Promise.resolve() // let the chain link start → save_session invoke now in flight
    expect(invoke).toHaveBeenCalledWith('save_session', { id: 'rel14-a', json: '{"v":1}' })

    const removeP = removeSession('rel14-a')
    // the delete is chained behind the save and must not have fired yet
    expect(invoke).not.toHaveBeenCalledWith('remove_session', expect.anything())

    resolveSave()
    await saveP
    await removeP

    const calls = vi.mocked(invoke).mock.calls.map(c => c[0])
    expect(calls).toEqual(['save_session', 'remove_session'])
    expect(invoke).toHaveBeenCalledWith('remove_session', { id: 'rel14-a' })
  })

  it('drops a queued-but-not-started save when the session is removed', async () => {
    let resolveFirst!: () => void
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      if (cmd === 'save_session' && (args as { json: string }).json === '{"v":1}') {
        return new Promise<void>(r => { resolveFirst = r })
      }
      return Promise.resolve() as Promise<never>
    })

    const firstP = saveSession('rel14-b', '{"v":1}')
    await Promise.resolve() // first save now in flight
    const secondP = saveSession('rel14-b', '{"v":2}') // queued behind it
    const removeP = removeSession('rel14-b') // must cancel the queued save, then delete

    resolveFirst()
    await firstP
    await secondP
    await removeP

    const calls = vi.mocked(invoke).mock.calls.map(c => [c[0], (c[1] as { json?: string }).json])
    // v2 is never written, and the delete lands after the in-flight v1 save
    expect(calls).toEqual([
      ['save_session', '{"v":1}'],
      ['remove_session', undefined],
    ])
  })
})
