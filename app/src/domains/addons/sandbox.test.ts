// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createAddonSandbox, sandboxDocument, type SandboxFrame } from './sandbox'
import { ADDON_RPC_METHODS, enforcePermissions } from '../../core/addons'
import type { AddonApi } from '../../core/addons'
import type { AddonPermission } from '../../core/types'

// A fake transport that mimics the in-iframe bootstrap in-process: it reruns the
// same api-proxy + handler-exec logic, so tests exercise the real HOST routing
// (whitelist validation, permission-enforced dispatch, result plumbing) without a
// browser frame. The true isolation (opaque origin / CSP) is asserted separately.
function fakeFrame(): SandboxFrame {
  let hostCb: Parameters<SandboxFrame['onMessage']>[0] = () => {}
  const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  let rpcSeq = 0
  const rpc = (callId: number, method: string, args: unknown[]) => new Promise((res, rej) => {
    const id = ++rpcSeq; pending.set(id, { res, rej })
    hostCb({ type: 'yaam:api', callId, id, method, args })
  })
  const buildApi = (snapshot: unknown, callId: number) => {
    const a: Record<string, unknown> = { getState: () => snapshot }
    for (const m of ADDON_RPC_METHODS) {
      if (m === 'getState') continue
      const parts = m.split('.'); let o = a as Record<string, unknown>
      for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] ??= {}; o = o[parts[i]] as Record<string, unknown> }
      o[parts[parts.length - 1]] = (...args: unknown[]) => rpc(callId, m, args)
    }
    return a
  }
  const runExec = async (msg: { callId: number; source: string; arg: unknown; snapshot: unknown }) => {
    try {
      const fn = new Function('input', 'api', '"use strict"; return (async () => {\n' + msg.source + '\n})();')
      const out = await fn(msg.arg, buildApi(msg.snapshot, msg.callId))
      hostCb({ type: 'yaam:result', callId: msg.callId, ok: true, value: out })
    } catch (e) {
      hostCb({ type: 'yaam:result', callId: msg.callId, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return {
    post: (msg: unknown) => {
      const m = msg as { type: string; id?: number; ok?: boolean; value?: unknown; error?: string }
      if (m.type === 'yaam:api-result') {
        const p = pending.get(m.id!); if (p) { pending.delete(m.id!); if (m.ok) p.res(m.value); else p.rej(new Error(m.error)) }
      } else if (m.type === 'yaam:exec') {
        void runExec(msg as { callId: number; source: string; arg: unknown; snapshot: unknown })
      }
    },
    onMessage: cb => { hostCb = cb; queueMicrotask(() => hostCb({ type: 'yaam:ready' })); return () => {} },
    destroy: () => {},
  }
}

function fakeApi(granted: AddonPermission[]): { api: AddonApi; flash: ReturnType<typeof vi.fn> } {
  const flash = vi.fn()
  const raw = {
    getState: () => ({ sessions: [{ id: 's1' }] }),
    sendToSession: vi.fn(), launchSession: vi.fn(() => 'new-id'), focusSession: vi.fn(),
    flash, logEvent: vi.fn(), notify: vi.fn(),
    sessions: { readOutput: vi.fn(() => 'out'), stop: vi.fn() },
    tasks: { add: vi.fn(() => 't1'), update: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), start: vi.fn(), restart: vi.fn(), chat: vi.fn(), get: vi.fn(() => null), approve: vi.fn(async () => 'ok'), reject: vi.fn() },
    templates: { list: vi.fn(() => []), run: vi.fn(() => null) },
    schedules: { add: vi.fn(() => 'c1'), toggle: vi.fn(), remove: vi.fn() },
    agent: { wake: vi.fn(async () => 'reply') },
    storage: { get: vi.fn(), set: vi.fn(), list: vi.fn(() => []), remove: vi.fn() },
    http: { request: vi.fn(async () => ({ status: 200, contentType: 'text/plain', text: 'ok' })) },
    secrets: { list: vi.fn(async () => []) },
  } as unknown as AddonApi
  return { api: enforcePermissions(raw, granted), flash }
}

describe('addon sandbox — isolation attributes', () => {
  it('sandboxes the frame at an opaque origin with a network-denying CSP', () => {
    const doc = sandboxDocument(ADDON_RPC_METHODS)
    expect(doc).toContain("default-src 'none'")   // no network (connect-src falls back to default)
    expect(doc).not.toContain('allow-same-origin') // opaque origin
    expect(doc).not.toContain("connect-src")       // nothing re-enables network
  })
})

describe('addon sandbox — host RPC routing', () => {
  let sb: ReturnType<typeof createAddonSandbox>
  beforeEach(() => { sb = createAddonSandbox(fakeFrame) })
  afterEach(() => sb.dispose())

  it('returns a handler value and serves getState from the injected snapshot', async () => {
    const { api } = fakeApi(['state:read'])
    const out = await sb.run('return api.getState().sessions[0].id', null, api)
    expect(out).toBe('s1')
  })

  it('routes a granted api call through to the host implementation', async () => {
    const { api, flash } = fakeApi(['ui'])
    await sb.run('await api.flash("hi"); return "done"', null, api)
    expect(flash).toHaveBeenCalledWith('hi')
  })

  it('keeps concurrent handlers bound to their own permission-scoped api', async () => {
    const first = fakeApi(['ui'])
    const second = fakeApi(['ui'])
    const slow = sb.run('await new Promise(r => setTimeout(r, 10)); await api.flash("first")', null, first.api)
    const fast = sb.run('await api.flash("second")', null, second.api)

    await Promise.all([slow, fast])
    expect(first.flash).toHaveBeenCalledWith('first')
    expect(first.flash).not.toHaveBeenCalledWith('second')
    expect(second.flash).toHaveBeenCalledWith('second')
  })

  it('rejects a permission-denied api call (surfaced to the handler)', async () => {
    const { api } = fakeApi([]) // no 'sessions:launch'
    const out = await sb.run('try { await api.launchSession("x"); return "ALLOWED" } catch (e) { return "denied:" + e.message }', null, api)
    expect(out).toMatch(/^denied:/)
    expect(out).toContain('sessions:launch')
  })

  it('propagates a handler throw as a rejection', async () => {
    const { api } = fakeApi([])
    await expect(sb.run('throw new Error("boom")', null, api)).rejects.toThrow('boom')
  })
})

describe('addon sandbox — termination', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('terminates a handler that exceeds its deadline', async () => {
    // a frame that never responds to exec → the deadline must fire
    const stuck: SandboxFrame = { post: () => {}, onMessage: cb => { cb({ type: 'yaam:ready' }); return () => {} }, destroy: vi.fn() }
    const sb = createAddonSandbox(() => stuck)
    const p = sb.run('while(true){}', null, fakeApi([]).api, 500)
    const assertion = expect(p).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(600)
    await assertion
  })
})
