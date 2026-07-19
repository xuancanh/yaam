export const MOVE_MENU_WIDTH = 224
export const MOVE_MENU_EDGE = 8
const MOVE_MENU_ROW_HEIGHT = 32

/** Clamp a session-move menu to the visible window. The returned maximum
 * height lets the target list scroll when all rows cannot fit. */
export function sessionMoveMenuPlacement(
  x: number,
  y: number,
  itemCount: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxHeight = Math.max(0, viewportHeight - MOVE_MENU_EDGE * 2)
  const desiredHeight = 38 + Math.max(itemCount, 1) * MOVE_MENU_ROW_HEIGHT + 8
  const height = Math.min(desiredHeight, maxHeight)
  return {
    left: Math.max(MOVE_MENU_EDGE, Math.min(x, viewportWidth - MOVE_MENU_WIDTH - MOVE_MENU_EDGE)),
    top: Math.max(MOVE_MENU_EDGE, Math.min(y, viewportHeight - height - MOVE_MENU_EDGE)),
    maxHeight,
  }
}
