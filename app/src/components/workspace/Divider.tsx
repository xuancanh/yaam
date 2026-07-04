/** Convert pointer drag distance into a clamped row or column split ratio. */
export function Divider({ dir, onRatio }: { dir: 'col' | 'row'; onRatio: (r: number) => void }) {
  // Capture the initial container geometry for a document-level drag.
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    // walk past display:contents wrappers, which have no box
    let parent = e.currentTarget.parentElement
    while (parent) {
      const r = parent.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) break
      parent = parent.parentElement
    }
    if (!parent) return
    const rect = parent.getBoundingClientRect()
    // Convert pointer position into the requested split ratio.
    const move = (ev: MouseEvent) => {
      const raw = dir === 'col'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      onRatio(Math.min(0.85, Math.max(0.15, raw)))
    }
    // Stop tracking once the pointer is released anywhere in the document.
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div
      className="pane-divider"
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        ...(dir === 'col' ? { width: 5, cursor: 'col-resize' } : { height: 5, cursor: 'row-resize' }),
      }}
    />
  )
}
