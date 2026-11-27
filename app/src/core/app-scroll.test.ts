import { describe, expect, it, vi } from 'vitest'
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }))
import { encodeAppScroll } from './terminals'

const base = { mouse: false, appCursor: false, encoding: 'SGR', cols: 80, rows: 24 }

describe('encodeAppScroll', () => {
  it('sends SGR wheel reports to a mouse-reporting TUI', () => {
    expect(encodeAppScroll({ ...base, mouse: true }, -2)).toBe('\x1b[<64;40;12M'.repeat(2))
    expect(encodeAppScroll({ ...base, mouse: true }, 1)).toBe('\x1b[<65;40;12M')
  })
  it('uses the legacy encoding when the app asked for it', () => {
    expect(encodeAppScroll({ ...base, mouse: true, encoding: 'DEFAULT' }, 1)).toBe('\x1b[M' + String.fromCharCode(97, 72, 44))
  })
  it('falls back to arrow keys, honoring application-cursor mode', () => {
    expect(encodeAppScroll(base, -3)).toBe('\x1b[A'.repeat(3))
    expect(encodeAppScroll({ ...base, appCursor: true }, 2)).toBe('\x1bOB'.repeat(2))
  })
  it('caps a burst and ignores zero', () => {
    expect(encodeAppScroll(base, 0)).toBe('')
    expect(encodeAppScroll(base, 500).length).toBe(30 * 3)
  })
})
