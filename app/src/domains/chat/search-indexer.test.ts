import { describe, expect, it, vi } from 'vitest'
import { createChatSearchIndexer } from './search-indexer'
import type { ChatSearchDoc } from './search-indexer'
import { createFakeStatePort, FakeClock } from '../../core/ports.fakes'
import type { AppState, Agent } from '../../core/types'

const chat = (id: string, log: Array<{ id: string; role: string; text: string }>): Agent =>
  ({ id, name: id, kind: 'chat', chatLog: log } as unknown as Agent)

const state = (agents: Agent[]): AppState => ({ agents } as unknown as AppState)

describe('createChatSearchIndexer', () => {
  it('debounces a reindex after a transcript change and includes only user/assistant messages', () => {
    const port = createFakeStatePort(state([chat('c1', [
      { id: 'm1', role: 'user', text: 'hello' },
      { id: 'm2', role: 'assistant', text: 'hi' },
      { id: 'm3', role: 'thinking', text: 'hmm' },
    ])]))
    const clock = new FakeClock()
    const reindex = vi.fn(async (_docs: ChatSearchDoc[]) => {})
    const idx = createChatSearchIndexer(port, clock, reindex)
    idx.start()

    // a transcript mutation arms the debounce
    port.set({ ...port.get(), agents: [chat('c1', [
      { id: 'm1', role: 'user', text: 'hello' }, { id: 'm2', role: 'assistant', text: 'hi' },
      { id: 'm3', role: 'thinking', text: 'hmm' }, { id: 'm4', role: 'user', text: 'again' },
    ])] })
    expect(reindex).not.toHaveBeenCalled() // still within debounce
    clock.advance(1500)
    expect(reindex).toHaveBeenCalledOnce()
    const docs = reindex.mock.calls[0][0]
    expect(docs.map(d => d.msgId)).toEqual(['m1', 'm2', 'm4']) // thinking dropped
  })

  it('does not reindex when non-transcript state changes', () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'x' }])]))
    const clock = new FakeClock()
    const reindex = vi.fn(async () => {})
    createChatSearchIndexer(port, clock, reindex).start()
    // replace an agent object without touching any chat transcript
    port.set({ ...port.get(), agents: [{ ...port.get().agents[0] }] })
    clock.advance(5000)
    expect(reindex).not.toHaveBeenCalled()
  })

  it('dispose() unsubscribes and cancels a pending reindex', () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'x' }])]))
    const clock = new FakeClock()
    const reindex = vi.fn(async () => {})
    const idx = createChatSearchIndexer(port, clock, reindex)
    idx.start()
    port.set({ ...port.get(), agents: [chat('c1', [{ id: 'm1', role: 'user', text: 'x' }, { id: 'm2', role: 'assistant', text: 'y' }])] })
    idx.dispose()
    clock.advance(5000)
    expect(reindex).not.toHaveBeenCalled()
    expect(clock.pending).toBe(0)
  })
})
