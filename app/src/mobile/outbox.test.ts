// @vitest-environment jsdom
// Typed messages survive a dropped connection (queued, sent in order on
// reconnect); taps like approvals are never replayed later.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discardOutbox, flushOutbox, onOutbox, sendCommand } from './api'

type Call = { kind: string; text: string }
function mockFetch(mode: { down: boolean; status?: number }) {
  const sent: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (mode.down) throw new TypeError('Failed to fetch')
    const body = JSON.parse(String(init?.body ?? '{}')) as Call
    if (mode.status && mode.status !== 200) return new Response('{}', { status: mode.status })
    sent.push({ kind: body.kind, text: body.text })
    return new Response('{"ok":true}', { status: 200 })
  }))
  return sent
}

afterEach(() => { discardOutbox(); vi.unstubAllGlobals() })

describe('mobile outbox', () => {
  it('queues typed messages while unreachable and sends them in order later', async () => {
    const mode = { down: true }
    const sent = mockFetch(mode)
    let count = -1
    const off = onOutbox(n => { count = n })
    await sendCommand({ kind: 'session_input', id: 's1', text: 'one' })
    mode.down = false
    // queued work keeps order: a later message waits behind the first
    await sendCommand({ kind: 'master_send', id: '', text: 'two' })
    await flushOutbox()
    expect(sent.map(c => c.text)).toEqual(['one', 'two'])
    expect(count).toBe(0)
    off()
  })

  it('never queues taps: an approval fails instead of replaying later', async () => {
    mockFetch({ down: true })
    let count = -1
    const off = onOutbox(n => { count = n })
    await expect(sendCommand({ kind: 'prompt_approve', id: 's1' })).rejects.toThrow()
    expect(count).toBe(0)
    off()
  })

  it('drops a message the desktop refuses instead of blocking the queue', async () => {
    const mode: { down: boolean; status?: number } = { down: true }
    const sent = mockFetch(mode)
    await sendCommand({ kind: 'chat_send', id: 'gone', text: 'refused' })
    mode.down = false
    mode.status = 400
    await flushOutbox()
    let count = -1
    onOutbox(n => { count = n })()
    expect(count).toBe(0)
    expect(sent).toEqual([])
  })
})
