import { describe, expect, it, vi } from 'vitest'
import { createTelemetry } from './telemetry'

describe('createTelemetry', () => {
  it('stamps `at`, retains events, and delivers them to subscribers', () => {
    const t = createTelemetry({ mirrorToConsole: false })
    const seen: string[] = []
    const off = t.subscribe(e => seen.push(e.message))
    t.emit({ severity: 'info', domain: 'commands', message: 'ran send_to_session', actor: 'user' })
    expect(seen).toEqual(['ran send_to_session'])
    expect(t.recent().at(-1)).toMatchObject({ domain: 'commands', message: 'ran send_to_session', actor: 'user' })
    expect(typeof t.recent().at(-1)!.at).toBe('number')
    off()
    t.emit({ severity: 'info', domain: 'x', message: 'after-unsub' })
    expect(seen).toEqual(['ran send_to_session']) // unsubscribed
  })

  it('bounds the ring to its cap', () => {
    const t = createTelemetry({ mirrorToConsole: false })
    for (let i = 0; i < 600; i++) t.emit({ severity: 'debug', domain: 'x', message: `${i}` })
    expect(t.recent().length).toBe(500)
    expect(t.recent().at(-1)!.message).toBe('599')
    expect(t.recent()[0].message).toBe('100') // oldest 100 dropped
  })

  it('mirrors warn/error to the console but not info/debug', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = createTelemetry() // mirror on by default
    t.emit({ severity: 'info', domain: 'x', message: 'quiet' })
    t.emit({ severity: 'warn', domain: 'persistence', message: 'save slow' })
    t.emit({ severity: 'error', domain: 'commands', message: 'denied' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    warn.mockRestore(); error.mockRestore()
  })

  it('a throwing subscriber does not break emit for others', () => {
    const t = createTelemetry({ mirrorToConsole: false })
    const good: string[] = []
    t.subscribe(() => { throw new Error('bad subscriber') })
    t.subscribe(e => good.push(e.message))
    t.emit({ severity: 'info', domain: 'x', message: 'ok' })
    expect(good).toEqual(['ok'])
  })
})
