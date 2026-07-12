// @vitest-environment jsdom
// The mobile API layer must build RELATIVE urls (so the app works on a LAN
// IP, Tailscale/WireGuard address, or behind a Cloudflare Tunnel unchanged)
// and keep a stable device identity + pairing token in localStorage.
import { describe, expect, it } from 'vitest'
import { apiUrl, deviceId, deviceToken, ensureUrlToken, forgetPairing, lastUrlToken, rememberUrlToken, storeDeviceToken, urlToken } from './api'

describe('mobile api layer', () => {
  it('reads the url token from the connect link', () => {
    expect(urlToken('?t=abc123')).toBe('abc123')
    expect(urlToken('?x=1&t=zzz')).toBe('zzz')
    expect(urlToken('')).toBe('')
  })

  it('builds relative urls only — no host, proxy/tunnel friendly', () => {
    const u = apiUrl('/api/state', { d: 'devtok' })
    expect(u.startsWith('/api/state?')).toBe(true)
    expect(u).not.toContain('http')
    expect(u).toContain('d=devtok')
    expect(u).toContain('t=') // url token always attached
  })

  it('device id is minted once and stays stable', () => {
    const a = deviceId()
    expect(a.length).toBeGreaterThanOrEqual(8)
    expect(deviceId()).toBe(a)
  })

  it('remembers the last working url token and re-applies it when the url is blank', () => {
    // start clean, at a bare url with no ?t=
    window.history.replaceState(null, '', '/')
    expect(lastUrlToken()).toBe('')
    expect(ensureUrlToken()).toBe('') // nothing to fall back to yet

    // a link with a token arrives and authenticates → remember it
    window.history.replaceState(null, '', '/?t=tok-123')
    expect(ensureUrlToken()).toBe('tok-123') // url wins when present
    rememberUrlToken('tok-123')
    expect(lastUrlToken()).toBe('tok-123')

    // later the app is opened bare (bookmark dropped the query)
    window.history.replaceState(null, '', '/')
    expect(urlToken()).toBe('') // truly blank
    expect(ensureUrlToken()).toBe('tok-123') // recovered from storage
    // …and it was put back on the address bar without a reload
    expect(urlToken()).toBe('tok-123')
    expect(apiUrl('/api/ping')).toContain('t=tok-123')
  })

  it('pairing token round-trips through storage and can be forgotten', () => {
    expect(deviceToken()).toBe('')
    storeDeviceToken('minted-by-desktop')
    expect(deviceToken()).toBe('minted-by-desktop')
    forgetPairing()
    expect(deviceToken()).toBe('')
  })
})
