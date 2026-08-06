// Accent color picker row: preset swatches plus a custom-color well that
// expands an inline HSV picker (saturation/value area, hue slider, hex field).
// Self-built — the native <input type="color"> panel anchors to the hidden
// input's position and appeared in a random screen corner. Shared by the
// tab/group context menus and the workspace accent row.
import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

const RAINBOW = 'conic-gradient(#FF7A7A, #F5C451, #3DDC97, #7FD1FF, #C77DFF, #FF7A7A)'

interface Hsv { h: number; s: number; v: number }

function hexToHsv(hex: string): Hsv {
  let x = hex.replace('#', '')
  if (x.length === 3) x = x.split('').map(c => c + c).join('')
  const r = parseInt(x.slice(0, 2), 16) / 255
  const g = parseInt(x.slice(2, 4), 16) / 255
  const b = parseInt(x.slice(4, 6), 16) / 255
  if ([r, g, b].some(Number.isNaN)) return { h: 45, s: 0.65, v: 0.95 }
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max }
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase()
}

/** Inline HSV picker: drag the area for saturation/value, slide for hue, or
 *  type a hex. Every change reports live through onPick. */
function MiniColorPicker({ initial, onPick }: { initial: string; onPick: (color: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initial))
  const [draft, setDraft] = useState(() => hsvToHex(hexToHsv(initial)))
  const svRef = useRef<HTMLDivElement>(null)

  const apply = (next: Hsv) => {
    setHsv(next)
    const hex = hsvToHex(next)
    setDraft(hex)
    onPick(hex)
  }

  const svFromPointer = (e: ReactPointerEvent) => {
    const box = svRef.current?.getBoundingClientRect()
    if (!box) return
    const s = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width))
    const v = 1 - Math.max(0, Math.min(1, (e.clientY - box.top) / box.height))
    apply({ ...hsv, s, v })
  }

  const commitDraft = () => {
    const m = draft.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i)
    if (m) apply(hexToHsv(`#${m[1]}`))
    else setDraft(hsvToHex(hsv)) // revert an unparseable draft
  }

  const hex = hsvToHex(hsv)
  return (
    <div style={{ padding: '2px 9px 8px', width: '100%' }}>
      <div
        ref={svRef}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId)
          svFromPointer(e)
        }}
        onPointerMove={e => { if (e.buttons & 1) svFromPointer(e) }}
        style={{
          position: 'relative', width: '100%', height: 96, borderRadius: 8, cursor: 'crosshair',
          border: '1px solid var(--line2)', touchAction: 'none',
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), hsl(${hsv.h}, 100%, 50%)`,
        }}
      >
        <span style={{
          position: 'absolute', left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`,
          width: 12, height: 12, borderRadius: '50%', transform: 'translate(-50%, -50%)',
          background: hex, border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,.45)',
          pointerEvents: 'none',
        }} />
      </div>
      <input
        className="hue-slider"
        type="range"
        min={0}
        max={360}
        step={1}
        value={Math.round(hsv.h)}
        aria-label="Hue"
        onChange={e => apply({ ...hsv, h: Number(e.target.value) })}
        style={{ width: '100%', margin: '9px 0 7px' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 18, height: 18, borderRadius: 6, background: hex, border: '1px solid var(--line2)', flexShrink: 0 }} />
        <input
          className="mono"
          value={draft}
          aria-label="Hex color"
          onChange={e => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={e => {
            e.stopPropagation() // menus close on Escape at the document level only
            if (e.key === 'Enter') commitDraft()
          }}
          style={{
            flex: 1, minWidth: 0, background: 'var(--bg2)', border: '1px solid var(--line)',
            borderRadius: 6, outline: 'none', color: 'var(--text)', fontSize: 11, padding: '4px 7px',
          }}
        />
      </div>
    </div>
  )
}

export function ColorSwatches({ colors, current, onPick, onClear }: {
  colors: readonly string[]
  current: string | undefined
  onPick: (color: string) => void
  /** when present, a dashed "theme default" swatch clears the color */
  onClear?: () => void
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const isPreset = !!current && colors.some(c => c.toLowerCase() === current.toLowerCase())
  const custom = current && !isPreset ? current : undefined
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 7, padding: '7px 9px' }}>
      {colors.map(c => {
        const selected = current?.toLowerCase() === c.toLowerCase()
        return (
          <button
            key={c}
            role="menuitem"
            aria-label={`Color ${c}`}
            onClick={() => { setCustomOpen(false); onPick(c) }}
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
        onClick={() => setCustomOpen(o => !o)}
        style={{
          width: 16, height: 16, borderRadius: '50%', cursor: 'pointer', padding: 0,
          background: custom ?? RAINBOW,
          border: custom || customOpen ? '2px solid var(--text)' : '2px solid transparent',
          boxShadow: custom ? `0 0 0 1.5px ${custom}` : 'none',
        }}
      />
      {onClear && (
        <button
          role="menuitem"
          aria-label="Default color"
          title="Theme default"
          onClick={() => { setCustomOpen(false); onClear() }}
          style={{
            width: 16, height: 16, borderRadius: '50%', background: 'transparent', cursor: 'pointer', padding: 0,
            border: !current ? '2px solid var(--text)' : '1.5px dashed var(--dim)',
          }}
        />
      )}
      {customOpen && <MiniColorPicker initial={current ?? colors[0] ?? '#F5C451'} onPick={onPick} />}
    </div>
  )
}
