import { afterEach, describe, expect, it, vi } from 'vitest'
import { callApi, providerFor } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('LLM response limits', () => {
  it('rejects an oversized declared response before JSON parsing', async () => {
    const fetchMock = vi.fn(async () => new Response('{"choices":[]}', {
      status: 200,
      headers: { 'content-length': String(5 * 1024 * 1024) },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(callApi({
      provider: providerFor('custom'), baseUrl: 'https://provider.test/v1', apiKey: 'key', model: 'model',
      awsRegion: '', awsProfile: '', awsRefreshCmd: '', credCmd: '',
    }, 'system', [{ role: 'user', content: 'hello' }], [])).rejects.toThrow(/response exceeds/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
