// The host stub itself: storage semantics, fixtures, handler overrides.
import { afterEach, describe, expect, it } from 'vitest'
import { createYaamClient } from '../src/bridge'
import type { YaamClient } from '../src/bridge'
import { createHostStub, fixtureSnapshot } from '../src/testing'
import type { HostStub } from '../src/testing'

let stub: HostStub | undefined
let client: YaamClient | undefined

afterEach(() => {
  stub?.dispose()
  client?.dispose()
  stub = undefined
  client = undefined
})

describe('host stub', () => {
  it('backs storage.* with the exposed map', async () => {
    stub = createHostStub({ storage: { seeded: 1 } })
    client = createYaamClient({ target: window })
    expect(await client.api.storage.get('seeded')).toBe(1)
    await client.api.storage.set('cfg', { on: true })
    expect(stub.storage.get('cfg')).toEqual({ on: true })
    expect(await client.api.storage.list()).toEqual(['seeded', 'cfg'])
    await client.api.storage.remove('seeded')
    expect(await client.api.storage.list()).toEqual(['cfg'])
  })

  it('lets handlers override built-ins (http.request)', async () => {
    stub = createHostStub({
      handlers: { 'http.request': () => ({ status: 200, contentType: 'application/json', text: '[]' }) },
    })
    client = createYaamClient({ target: window })
    const res = await client.api.http.request('GET', 'https://api.github.com/x')
    expect(res.status).toBe(200)
  })

  it('http.request without a handler fails loudly', async () => {
    stub = createHostStub()
    client = createYaamClient({ target: window })
    await expect(client.api.http.request('GET', 'https://x.y')).rejects.toThrow('no http handler')
  })

  it('fixtureSnapshot applies overrides on a plausible default', () => {
    const s = fixtureSnapshot({ workspace: 'W', tasks: [] })
    expect(s.workspace).toBe('W')
    expect(s.tasks).toEqual([])
    expect(s.sessions.length).toBeGreaterThan(0)
    expect(s.totals.running).toBe(1)
  })

  it('pushState merges a patch and notifies subscribers', async () => {
    stub = createHostStub()
    client = createYaamClient({ target: window })
    const seen: string[] = []
    client.onState(s => { if (s) seen.push(s.workspace) })
    await new Promise(r => setTimeout(r, 0))
    stub.pushState({ workspace: 'After' })
    await new Promise(r => setTimeout(r, 0))
    expect(seen).toContain('After')
  })
})
