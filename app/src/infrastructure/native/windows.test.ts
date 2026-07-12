// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Simulate the desktop app and control the close event + this window's label.
vi.mock('./base', () => ({ isTauri: true }))
let closeCb: ((label: string) => void) | undefined
const currentLabel = vi.fn(() => 'ws-x')
vi.mock('./session', () => ({
  onCloseRequested: vi.fn((cb: (label: string) => void) => { closeCb = cb; return () => { closeCb = undefined } }),
  currentWindowLabel: () => currentLabel(),
}))

import { onThisWindowClose } from './windows'

beforeEach(() => { vi.clearAllMocks(); closeCb = undefined; currentLabel.mockReturnValue('ws-x') })

describe('onThisWindowClose — window-scoped close', () => {
  it('runs the teardown only for THIS window, ignoring other windows closing', () => {
    const cb = vi.fn()
    onThisWindowClose(cb)
    closeCb!('main')      // a different window closed → ignore
    expect(cb).not.toHaveBeenCalled()
    closeCb!('ws-x')      // this window closed → run
    expect(cb).toHaveBeenCalledOnce()
  })

  it('the main window only reacts to its own close, not a satellite closing', () => {
    currentLabel.mockReturnValue('main')
    const cb = vi.fn()
    onThisWindowClose(cb)
    closeCb!('ws-x')      // a satellite closed → main must not tear down
    expect(cb).not.toHaveBeenCalled()
    closeCb!('main')
    expect(cb).toHaveBeenCalledOnce()
  })
})
