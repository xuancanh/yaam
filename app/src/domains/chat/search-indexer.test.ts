import { describe, expect, it, vi } from 'vitest'
import { createChatSearchIndexer } from './search-indexer'
import type { ChatSearchDoc, ChatSearchOps } from './search-indexer'
import { createFakeStatePort, FakeClock } from '../../core/ports.fakes'
import type { AppState, Agent } from '../../core/types'

const chat = (id: string, log: Array<{ id: string; role: string; text: string }>): Agent =>
  ({ id, name: id, kind: 'chat', chatLog: log } as unknown as Agent)

const state = (agents: Agent[]): AppState => ({ agents } as unknown as AppState)

function spyOps() {
  return {
    reindex: vi.fn(async (_docs: ChatSearchDoc[]) => {}),
    upsert: vi.fn(async (_docs: ChatSearchDoc[]) => {}),
    remove: vi.fn(async (_ids: string[]) => {}),
  } satisfies ChatSearchOps
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createChatSearchIndexer', () => {
  it('does a full reindex on the first sync, user/assistant messages only', () => {
    const port = createFakeStatePort(state([chat('c1', [
      { id: 'm1', role: 'user', text: 'hello' },
      { id: 'm2', role: 'assistant', text: 'hi' },
      { id: 'm3', role: 'thinking', text: 'hmm' },
    ])]))
    const clock = new FakeClock()
    const ops = spyOps()
    createChatSearchIndexer(port, clock, ops).start()

    port.set({ ...port.get(), agents: [chat('c1', [
      { id: 'm1', role: 'user', text: 'hello' }, { id: 'm2', role: 'assistant', text: 'hi' },
      { id: 'm3', role: 'thinking', text: 'hmm' }, { id: 'm4', role: 'user', text: 'again' },
    ])] })
    expect(ops.reindex).not.toHaveBeenCalled() // still within debounce
    clock.advance(1500)
    expect(ops.reindex).toHaveBeenCalledOnce()
    expect(ops.reindex.mock.calls[0][0].map(d => d.msgId)).toEqual(['m1', 'm2', 'm4']) // thinking dropped
    expect(ops.upsert).not.toHaveBeenCalled()
  })

  it('upserts only new/edited messages on later syncs (not a full rebuild)', async () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'hello' }])]))
    const clock = new FakeClock()
    const ops = spyOps()
    createChatSearchIndexer(port, clock, ops).start()
    // first sync → full reindex
    port.set({ ...port.get(), agents: [chat('c1', [{ id: 'm1', role: 'user', text: 'hello' }])] })
    clock.advance(1500)
    await flush()
    expect(ops.reindex).toHaveBeenCalledOnce()

    // add m2 and edit m1 → incremental upsert of exactly those two
    port.set({ ...port.get(), agents: [chat('c1', [
      { id: 'm1', role: 'user', text: 'hello edited' },
      { id: 'm2', role: 'assistant', text: 'brand new' },
    ])] })
    clock.advance(1500)
    expect(ops.reindex).toHaveBeenCalledOnce() // not rebuilt
    expect(ops.upsert).toHaveBeenCalledOnce()
    expect(ops.upsert.mock.calls[0][0].map(d => d.msgId).sort()).toEqual(['m1', 'm2'])
  })

  it('removes messages that disappeared from the transcript', async () => {
    const port = createFakeStatePort(state([chat('c1', [
      { id: 'm1', role: 'user', text: 'a' }, { id: 'm2', role: 'assistant', text: 'b' },
    ])]))
    const clock = new FakeClock()
    const ops = spyOps()
    createChatSearchIndexer(port, clock, ops).start()
    port.set({ ...port.get(), agents: [chat('c1', [
      { id: 'm1', role: 'user', text: 'a' }, { id: 'm2', role: 'assistant', text: 'b' },
    ])] })
    clock.advance(1500) // full reindex, indexed = {m1, m2}
    await flush()

    // delete the whole chat → both removed, nothing upserted
    port.set({ ...port.get(), agents: [] })
    clock.advance(1500)
    expect(ops.remove).toHaveBeenCalledOnce()
    expect(ops.remove.mock.calls[0][0].sort()).toEqual(['m1', 'm2'])
    expect(ops.upsert).not.toHaveBeenCalled()
  })

  it('retries a failed native sync without advancing the indexed snapshot', async () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'hello' }])]))
    const clock = new FakeClock()
    const ops = spyOps()
    ops.reindex.mockRejectedValueOnce(new Error('index locked'))
    createChatSearchIndexer(port, clock, ops).start()

    port.set({ ...port.get(), agents: [chat('c1', [{ id: 'm1', role: 'user', text: 'hello' }, { id: 'm2', role: 'assistant', text: 'again' }])] })
    clock.advance(1500)
    await flush()
    expect(ops.reindex).toHaveBeenCalledOnce()
    expect(clock.pending).toBe(1)

    clock.advance(5000)
    await flush()
    expect(ops.reindex).toHaveBeenCalledTimes(2)
    expect(ops.upsert).not.toHaveBeenCalled()
  })

  it('does nothing when a non-transcript state change occurs', () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'x' }])]))
    const clock = new FakeClock()
    const ops = spyOps()
    createChatSearchIndexer(port, clock, ops).start()
    port.set({ ...port.get(), agents: [{ ...port.get().agents[0] }] }) // same transcript
    clock.advance(5000)
    expect(ops.reindex).not.toHaveBeenCalled()
  })

  it('dispose() unsubscribes, cancels a pending sync, and resets so a restart re-syncs fully', () => {
    const port = createFakeStatePort(state([chat('c1', [{ id: 'm1', role: 'user', text: 'x' }])]))
    const clock = new FakeClock()
    const ops = spyOps()
    const idx = createChatSearchIndexer(port, clock, ops)
    idx.start()
    port.set({ ...port.get(), agents: [chat('c1', [{ id: 'm1', role: 'user', text: 'x' }, { id: 'm2', role: 'assistant', text: 'y' }])] })
    idx.dispose()
    clock.advance(5000)
    expect(ops.reindex).not.toHaveBeenCalled()
    expect(clock.pending).toBe(0)
  })
})
