import { afterEach, describe, expect, it, vi } from 'vitest'
import { callApi, callApiStream, providerFor } from './client'
import type { LlmConfig } from './client'

const mocks = vi.hoisted(() => ({ runCredentialCommand: vi.fn() }))

vi.mock('../core/native', async importOriginal => ({
  ...await importOriginal<typeof import('../core/native')>(),
  runCredentialCommand: mocks.runCredentialCommand,
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  mocks.runCredentialCommand.mockReset()
})

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: providerFor('custom'), baseUrl: 'https://provider.test/v1', apiKey: 'key', model: 'model',
  awsRegion: '', awsProfile: '', awsRefreshCmd: '', credCmd: '', ...over,
})

const messages = [{ role: 'user' as const, content: 'hi' }]
const okBody = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
})
const errBody = (message: string) => JSON.stringify({ error: { message } })

describe('transient API retry', () => {
  it('retries a 429 once and succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(errBody('slow down'), { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = callApi(cfg(), 'sys', messages, [])
    await vi.runAllTimersAsync()
    const res = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.content).toContainEqual({ type: 'text', text: 'hi' })
  })

  it('retries a 500 once and succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(errBody('boom'), { status: 500 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = callApi(cfg(), 'sys', messages, [])
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toMatchObject({ stop_reason: 'end_turn' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after one retry when the error persists', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(errBody('boom'), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = callApi(cfg(), 'sys', messages, [])
    const assertion = expect(promise).rejects.toThrow(/boom/)
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + single bounded retry
  })

  it('does not retry other 4xx', async () => {
    const fetchMock = vi.fn(async () => new Response(errBody('bad request'), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callApi(cfg(), 'sys', messages, [])).rejects.toThrow(/bad request/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After on a 429', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(errBody('slow down'), { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = callApi(cfg(), 'sys', messages, [])
    await vi.advanceTimersByTimeAsync(0) // first attempt done, backoff timer armed
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fetchMock).toHaveBeenCalledTimes(1) // still inside the 2s wait
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBeDefined()
  })

  it('caps a long Retry-After at 5s', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(errBody('slow down'), { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = callApi(cfg(), 'sys', messages, [])
    await vi.advanceTimersByTimeAsync(0) // first attempt done, backoff timer armed
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetchMock).toHaveBeenCalledTimes(1) // capped, not the server's 30s
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBeDefined()
  })

  it('applies the same retry to the streaming path', async () => {
    vi.useFakeTimers()
    const sse = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(errBody('unavailable'), { status: 503 }))
      .mockResolvedValueOnce(new Response(sse, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const deltas: string[] = []
    const promise = callApiStream(cfg(), 'sys', messages, [], d => deltas.push(d))
    await vi.runAllTimersAsync()
    const res = await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(deltas.join('')).toBe('hello')
    expect(res.content).toContainEqual({ type: 'text', text: 'hello' })
  })

  it('cancels the rejected body before the 401 credential-refresh retry', async () => {
    mocks.runCredentialCommand.mockResolvedValue('fresh-key')
    const rejected = new Response(errBody('unauthorized'), { status: 401 })
    const cancelSpy = vi.spyOn(rejected.body!, 'cancel')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await callApi(cfg({ credCmd: 'print-key' }), 'sys', messages, [])

    expect(mocks.runCredentialCommand).toHaveBeenCalledWith('print-key')
    expect(cancelSpy).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // the retry carries the refreshed credential
    const retryInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
    expect(retryInit.headers.authorization).toBe('Bearer fresh-key')
    expect(res.content).toContainEqual({ type: 'text', text: 'hi' })
  })
})
