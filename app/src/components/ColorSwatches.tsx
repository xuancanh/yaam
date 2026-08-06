// Accent color picker row: preset swatches plus a custom-color well (native
// color input behind a rainbow swatch). Shared by the tab/group context menus
// and the workspace accent row.
import { useRef } from 'react'

const RAINBOW = 'conic-gradient(#FF7A7A, #F5C451, #3DDC97, #7FD1FF, #C77DFF, #FF7A7A)'

export function ColorSwatches({ colors, current, onPick, onClear }: {
  colors: readonly string[]
  current: string | undefined
  onPick: (color: string) => void
  /** when present, a dashed "theme default" swatch clears the color */
  onClear?: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const isPreset = !!current && colors.some(c => c.toLowerCase() === current.toLowerCase())
  const custom = current && !isPreset ? current : undefined
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, padding: '7px 9px', position: 'relative' }}>
      {colors.map(c => {
        const selected = current?.toLowerCase() === c.toLowerCase()
        return (
          <button
            key={c}
            role="menuitem"
            aria-label={`Color ${c}`}
            onClick={() => onPick(c)}
            style={{
              width: 16, height: 16, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
              border: selected ? '2px solid var(--text)' : '2px solid transparent',
              boxShadow: selected ? `0 0 0 1.5px ${c}` : 'none',
            }}
          />
        )
      })}
      <button
        role="menuitem"
        aria-label="Custom color"
        title="Custom color…"
        onClick={() => input.current?.click()}
        style={{
          width: 16, height: 16, borderRadius: '50%', cursor: 'pointer', padding: 0,
          background: custom ?? RAINBOW,
          border: custom ? '2px solid var(--text)' : '2px solid transparent',
          boxShadow: custom ? `0 0 0 1.5px ${custom}` : 'none',
        }}
      />
      <input
        ref={input}
        type="color"
        aria-hidden
        tabIndex={-1}
        value={custom ?? colors[0] ?? '#F5C451'}
        onChange={e => onPick(e.target.value)}
        style={{ position: 'absolute', bottom: 0, right: 9, width: 0, height: 0, opacity: 0, border: 'none', padding: 0, pointerEvents: 'none' }}
      />
      {onClear && (
        <button
          role="menuitem"
          aria-label="Default color"
          title="Theme default"
          onClick={onClear}
          style={{
            width: 16, height: 16, borderRadius: '50%', background: 'transparent', cursor: 'pointer', padding: 0,
            border: !current ? '2px solid var(--text)' : '1.5px dashed var(--dim)',
          }}
        />
      )}
    </div>
  )
}
