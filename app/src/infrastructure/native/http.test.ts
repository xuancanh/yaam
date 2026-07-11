import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpRequest } from './http'

describe('httpRequest', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('passes manual redirect policy through for allowlisted addon requests', async () => {
    const fetchMock = vi.fn(async () => new Response('redirect', {
      status: 302,
      headers: { 'content-type': 'text/plain', location: 'https://undeclared.example/' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await httpRequest('GET', 'https://allowed.example/start', {}, undefined, 'manual')

    expect(fetchMock).toHaveBeenCalledWith('https://allowed.example/start', expect.objectContaining({ redirect: 'manual' }))
    expect(result.status).toBe(302)
  })
})
