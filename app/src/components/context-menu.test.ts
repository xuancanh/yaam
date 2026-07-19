import { describe, expect, it } from 'vitest'
import { CONTEXT_MENU_EDGE, contextMenuPlacement } from './context-menu'

describe('contextMenuPlacement', () => {
  it('keeps a measured menu inside the bottom-right edge', () => {
    expect(contextMenuPlacement(980, 690, 224, 160, 1000, 700)).toEqual({ left: 768, top: 532 })
  })

  it('clamps invalid and top-left coordinates to the safe edge', () => {
    expect(contextMenuPlacement(-20, -10, 180, 120, 800, 600)).toEqual({ left: CONTEXT_MENU_EDGE, top: CONTEXT_MENU_EDGE })
  })

  it('keeps a menu usable in a viewport narrower than its preferred size', () => {
    expect(contextMenuPlacement(100, 50, 164, 120, 180, 300).left).toBe(CONTEXT_MENU_EDGE)
  })
})
