// Appearance: stamps the user's theme/typography/density choices onto <html>
// so index.css palettes and variables take effect. Pure DOM — no React.
import type { AppearanceSettings } from '../core/types'

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
  root.setAttribute('data-theme', resolveTheme(cfg.theme))
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
