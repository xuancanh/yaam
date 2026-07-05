// @vitest-environment jsdom
// The mobile API layer must build RELATIVE urls (so the app works on a LAN
// IP, Tailscale/WireGuard address, or behind a Cloudflare Tunnel unchanged)
// and keep a stable device identity + pairing token in localStorage.
import { describe, expect, it } from 'vitest'
import { apiUrl, deviceId, deviceToken, forgetPairing, storeDeviceToken, urlToken } from './api'

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

  it('pairing token round-trips through storage and can be forgotten', () => {
    expect(deviceToken()).toBe('')
    storeDeviceToken('minted-by-desktop')
    expect(deviceToken()).toBe('minted-by-desktop')
    forgetPairing()
    expect(deviceToken()).toBe('')
  })
})
