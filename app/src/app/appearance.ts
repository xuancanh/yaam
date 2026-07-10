// Appearance: stamps the user's theme/typography/density choices onto <html>
// so index.css palettes and variables take effect. Pure DOM — no React.
import type { AppearanceSettings } from '../core/types'
import { applyTerminalTheme } from '../core/terminals'

export const FONT_STACKS = {
  sans: {
    plex: "'IBM Plex Sans', system-ui, sans-serif",
    system: 'system-ui, -apple-system, sans-serif',
    grotesk: "'Space Grotesk', system-ui, sans-serif",
  },
  mono: {
    jetbrains: "'JetBrains Mono', monospace",
    system: 'ui-monospace, SF Mono, Menlo, monospace',
  },
} as const

/** UI-scale bounds shared by the settings stepper and the ⌘+/⌘− shortcuts. */
export const SCALE_MIN = 80
export const SCALE_MAX = 140
export const SCALE_STEP = 5

/** One zoom step from `current` (percent): dir −1/+1 steps and clamps on the
 *  shared 5% grid; dir 0 resets to 100. */
export function steppedUiScale(current: number | undefined, dir: -1 | 0 | 1): number {
  if (dir === 0) return 100
  const cur = current ?? 100
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(cur / SCALE_STEP) * SCALE_STEP + dir * SCALE_STEP))
}

export const APPEARANCE_DEFAULTS: Required<AppearanceSettings> = {
  theme: 'dark',
  uiScale: 100,
  density: 'normal',
  uiFont: 'plex',
  monoFont: 'jetbrains',
  tableFontSize: 13,
  tableFont: 'sans',
}

/** 'system' resolves against the OS scheme; everything else is explicit. */
export function resolveTheme(theme: Required<AppearanceSettings>['theme']): string {
  if (theme !== 'system') return theme
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Apply one appearance snapshot to the document root. */
export function applyAppearance(a?: AppearanceSettings): void {
  if (typeof document === 'undefined') return
  const cfg = { ...APPEARANCE_DEFAULTS, ...a }
  const root = document.documentElement
  const theme = resolveTheme(cfg.theme)
  root.setAttribute('data-theme', theme)
  applyTerminalTheme(theme) // xterm canvases can't read CSS variables
  root.setAttribute('data-density', cfg.density)
  const style = root.style as CSSStyleDeclaration & { zoom?: string }
  // zoom scales the whole UI (fonts + spacing) — the pragmatic scale knob for
  // an app styled with absolute px values; WebKit and Chromium both support it
  style.zoom = cfg.uiScale === 100 ? '' : String(cfg.uiScale / 100)
  root.style.setProperty('--font-sans', FONT_STACKS.sans[cfg.uiFont] ?? FONT_STACKS.sans.plex)
  root.style.setProperty('--font-mono', FONT_STACKS.mono[cfg.monoFont] ?? FONT_STACKS.mono.jetbrains)
  root.style.setProperty('--table-font-size', `${cfg.tableFontSize}px`)
  root.style.setProperty('--table-font', cfg.tableFont === 'mono' ? 'var(--font-mono)' : 'var(--font-sans)')
}
