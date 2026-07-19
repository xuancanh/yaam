export const CONTEXT_MENU_EDGE = 8

/** Clamp a measured context menu to the visible viewport on every edge. */
export function contextMenuPlacement(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxLeft = Math.max(CONTEXT_MENU_EDGE, viewportWidth - width - CONTEXT_MENU_EDGE)
  const maxTop = Math.max(CONTEXT_MENU_EDGE, viewportHeight - height - CONTEXT_MENU_EDGE)
  return {
    left: Math.max(CONTEXT_MENU_EDGE, Math.min(x, maxLeft)),
    top: Math.max(CONTEXT_MENU_EDGE, Math.min(y, maxTop)),
  }
}
