import type { ReactNode } from 'react'
import { useActions, useConductorSelector, shallowEqual } from '../../store'
import { APPEARANCE_DEFAULTS, SCALE_MAX, SCALE_MIN, SCALE_STEP } from '../../app/appearance'
import type { AppearanceSettings } from '../../core/types'
import { FIELD_STYLE } from './common'
import { SectionLabel } from './SectionLabel'

/** −/＋ stepper for the interface scale — more reliable than a drag slider for
 *  landing on an exact 5% increment. */
function ScaleStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.max(SCALE_MIN, Math.min(SCALE_MAX, v))
  const step = (dir: -1 | 1) => onChange(clamp(Math.round(value / SCALE_STEP) * SCALE_STEP + dir * SCALE_STEP))
  const btn = (label: string, dir: -1 | 1, disabled: boolean) => (
    <button
      className="icon-btn"
      onClick={() => step(dir)}
      disabled={disabled}
      title={dir < 0 ? 'Smaller' : 'Larger'}
      style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line2)', fontSize: 16, opacity: disabled ? 0.4 : 1 }}
    >
      {label}
    </button>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {btn('−', -1, value <= SCALE_MIN)}
      <span className="mono" style={{ fontSize: 12.5, width: 44, textAlign: 'center', fontWeight: 600 }}>{value}%</span>
      {btn('＋', 1, value >= SCALE_MAX)}
    </div>
  )
}

/** One labeled appearance row with the control on the right. */
function AppearanceRow({ label, detail, children, last }: { label: string; detail: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 0', borderBottom: last ? 'none' : '1px solid var(--line-soft)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>{detail}</div>
      </div>
      {children}
    </div>
  )
}

/** Theme, UI scale, density, and typography (Settings → General). */
export function AppearanceSection() {
  const s = useConductorSelector(x => ({ appearance: x.settings.appearance }), shallowEqual)
  const { updateSettings } = useActions()
  const a = { ...APPEARANCE_DEFAULTS, ...s.appearance }
  const patch = (p: AppearanceSettings) => updateSettings({ appearance: { ...s.appearance, ...p } })
  return (
    <>
      <SectionLabel>APPEARANCE</SectionLabel>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 13, padding: '5px 16px', marginBottom: 26 }}>
        <AppearanceRow label="Theme" detail="Color palette for the whole app; System follows the OS light/dark setting.">
          <select value={a.theme} onChange={e => patch({ theme: e.target.value as AppearanceSettings['theme'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="dark">Dark</option>
            <option value="midnight">Midnight</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface scale" detail="Scales all text and spacing together.">
          <ScaleStepper value={a.uiScale} onChange={v => patch({ uiScale: v })} />
        </AppearanceRow>
        <AppearanceRow label="Density" detail="Row spacing and message padding in chats and lists.">
          <select value={a.density} onChange={e => patch({ density: e.target.value as AppearanceSettings['density'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="compact">Compact</option>
            <option value="normal">Normal</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Interface font" detail="The sans-serif face used across the app.">
          <select value={a.uiFont} onChange={e => patch({ uiFont: e.target.value as AppearanceSettings['uiFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="plex">IBM Plex Sans</option>
            <option value="system">System</option>
            <option value="grotesk">Space Grotesk</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Monospace font" detail="Code, paths, terminals-adjacent labels.">
          <select value={a.monoFont} onChange={e => patch({ monoFont: e.target.value as AppearanceSettings['monoFont'] })} style={{ ...FIELD_STYLE, width: 160 }}>
            <option value="jetbrains">JetBrains Mono</option>
            <option value="system">System mono</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label="Table typography" detail="Font size and family for markdown tables in chat replies." last>
          <input
            type="number" min={10} max={20}
            value={a.tableFontSize}
            onChange={e => patch({ tableFontSize: Math.max(10, Math.min(20, Number(e.target.value) || 13)) })}
            style={{ ...FIELD_STYLE, width: 64 }}
          />
          <select value={a.tableFont} onChange={e => patch({ tableFont: e.target.value as AppearanceSettings['tableFont'] })} style={{ ...FIELD_STYLE, width: 120 }}>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
        </AppearanceRow>
      </div>
    </>
  )
}
