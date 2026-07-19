import { describe, expect, it } from 'vitest'
import { MOVE_MENU_EDGE, sessionMoveMenuPlacement } from './move-menu'

describe('sessionMoveMenuPlacement', () => {
  it('keeps a menu opened near the bottom-right inside the viewport', () => {
    expect(sessionMoveMenuPlacement(990, 690, 3, 1000, 700)).toEqual({
      left: 768,
      top: 550,
      maxHeight: 684,
    })
  })

  it('never places the menu past the top or left safe edge', () => {
    const placement = sessionMoveMenuPlacement(-10, -20, 1, 1000, 700)
    expect(placement.left).toBe(MOVE_MENU_EDGE)
    expect(placement.top).toBe(MOVE_MENU_EDGE)
  })

  it('bounds a long workspace list so its rows can scroll', () => {
    expect(sessionMoveMenuPlacement(100, 400, 50, 900, 500)).toEqual({
      left: 100,
      top: 8,
      maxHeight: 484,
    })
  })

  it('still fits a narrow window by relying on the menu max-width', () => {
    expect(sessionMoveMenuPlacement(120, 20, 2, 180, 300).left).toBe(MOVE_MENU_EDGE)
  })
})
