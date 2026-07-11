// Bridge ↔ host-stub round trips over real (jsdom) postMessage.
import { afterEach, describe, expect, it } from 'vitest'
import { createYaamClient } from '../src/bridge'
import type { YaamClient } from '../src/bridge'
import { createHostStub } from '../src/testing'
import type { HostStub } from '../src/testing'
import type { AddonSnapshot } from '../src/types'

let stub: HostStub | undefined
let client: YaamClient | undefined

afterEach(() => {
  stub?.dispose()
  client?.dispose()
  stub = undefined
  client = undefined
})

const connect = () => createYaamClient({ target: window, onError: () => {} })

describe('bridge RPC', () => {
  it('round-trips a typed api call and records it', async () => {
    stub = createHostStub()
    client = connect()
    const id = await client.api.tasks.add('New thing', 'backlog', { criteria: ['works'] })
    expect(id).toMatch(/^stub-t/)
    expect(stub.calls).toEqual([{ method: 'tasks.add', args: ['New thing', 'backlog', { criteria: ['works'] }] }])
    expect(stub.state.tasks.some(t => t.title === 'New thing')).toBe(true)
  })

  it('rejects denied methods with the host error text', async () => {
    stub = createHostStub({ granted: ['state:read'] })
    client = connect()
    await expect(client.api.tasks.add('nope')).rejects.toThrow('permission "tasks" not granted')
  })

  it('rejects unknown methods like the host whitelist does', async () => {
    stub = createHostStub()
    client = connect()
    await expect(client.call('exec', 'rm -rf /')).rejects.toThrow('unknown method exec')
    await expect(client.call('nope.nope')).rejects.toThrow('unknown method nope.nope')
  })

  it('delivers state pushes to onState subscribers', async () => {
    stub = createHostStub({ state: { workspace: 'Test WS' } })
    client = connect()
    const s = await new Promise<AddonSnapshot>(resolve => {
      client?.onState(st => { if (st) resolve(st) })
    })
    expect(s.workspace).toBe('Test WS')
    expect(s.tasks.length).toBeGreaterThan(0)
    expect(client.state()?.workspace).toBe('Test WS')
  })

  it('reports denied state pushes', async () => {
    stub = createHostStub({ granted: [] })
    client = connect()
    const denied = await new Promise<string | undefined>(resolve => {
      client?.onState((st, d) => { if (st === null && d) resolve(d) })
    })
    expect(denied).toBe('state:read')
  })

  it('guard reports rejections through onError and resolves the fallback', async () => {
    stub = createHostStub({ granted: [] })
    const errors: string[] = []
    client = createYaamClient({ target: window, onError: m => errors.push(m) })
    const out = await client.guard(client.api.storage.get('k'), 'fallback')
    expect(out).toBe('fallback')
    expect(errors[0]).toContain('permission "storage" not granted')
  })
})
