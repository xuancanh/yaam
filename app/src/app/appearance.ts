// Appearance: stamps the user's theme/typography/density choices onto <html>
// so index.css palettes and variables take effect. Pure DOM — no React.
import type { AppearanceSettings } from '../core/types'
import { accentedTermTheme, applyTerminalTheme, setTerminalAccent } from '../core/terminals'
import { isTauri } from '../infrastructure/native/base'
import { setWebviewZoom } from '../infrastructure/native/windows'

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
  viewerTheme: 'auto',
  accent: '',
  accentTint: false,
  terminalTheme: 'dark',
  uiScale: 100,
  density: 'normal',
  uiFont: 'plex',
  monoFont: 'jetbrains',
  tableFontSize: 13,
  tableFont: 'sans',
}

/** Accent presets shown in Settings → Appearance (custom well appended). */
export const ACCENT_PRESETS = ['#F5C451', '#6FA8FF', '#3DDC97', '#C77DFF', '#FF7A7A', '#5BD8C8'] as const

// surface variables the accent tint rewrites (strongest on lines/hover, where
// a hue read as "chrome" rather than "background wash")
const TINT_VARS: Array<[name: string, amount: number]> = [
  ['--bg', 0.05], ['--bg2', 0.05], ['--bg3', 0.04],
  ['--panel', 0.06], ['--panel2', 0.07], ['--panel3', 0.08],
  ['--line', 0.1], ['--line2', 0.1], ['--line3', 0.1], ['--line-soft', 0.08],
  ['--hover', 0.1],
]

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Blend `amount` of `tint` into `base` (both #rrggbb). */
function mixHex(base: string, tint: string, amount: number): string {
  const b = parseHex(base)
  const t = parseHex(tint)
  if (!b || !t) return base
  const c = b.map((v, i) => Math.round(v + (t[i] - v) * amount))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

/** Apply (or clear) the custom accent: the accent/selection variables, the
 *  terminal cursor palette, and — with tint on — a wash of the accent's hue
 *  over every surface variable, derived from the active theme's own values. */
function applyAccent(root: HTMLElement, accent: string, tint: boolean): void {
  // always start from the theme's baseline so switching/clearing never stacks
  root.style.removeProperty('--accent')
  root.style.removeProperty('--selection')
  for (const [name] of TINT_VARS) root.style.removeProperty(name)
  const rgb = parseHex(accent)
  setTerminalAccent(rgb ? accent : null)
  if (!rgb) return
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--selection', `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.28)`)
  if (!tint) return
  // read each surface's theme value (overrides were just cleared) and blend
  const computed = getComputedStyle(root)
  for (const [name, amount] of TINT_VARS) {
    const base = computed.getPropertyValue(name).trim()
    if (base) root.style.setProperty(name, mixHex(base, accent, amount))
  }
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
  applyAccent(root, cfg.accent, cfg.accentTint)
  // terminals keep their OWN palette (dark by default): a light app theme
  // shouldn't force a light terminal. The attr is what newly-created xterms
  // read; --term-bg lets the pane's padding chrome match the canvas.
  const termTheme = cfg.terminalTheme === 'auto' ? theme : cfg.terminalTheme
  root.setAttribute('data-term-theme', termTheme)
  applyTerminalTheme(termTheme) // xterm canvases can't read CSS variables (accent included above)
  root.style.setProperty('--term-bg', accentedTermTheme(termTheme).background)
  root.setAttribute('data-density', cfg.density)
  // viewer syntax palette: 'auto' clears the attribute so the theme's own
  // token colors apply; anything else overrides just the --hl-* variables
  if (cfg.viewerTheme === 'auto') root.removeAttribute('data-viewer-theme')
  else root.setAttribute('data-viewer-theme', cfg.viewerTheme)
  const style = root.style as CSSStyleDeclaration & { zoom?: string }
  // Scale the whole UI (fonts + spacing) — the pragmatic knob for an app styled
  // in absolute px. Prefer the WebView's native zoom: CSS `zoom` on the root
  // overflows our 100vh/100vw layout wherever the engine follows the *new*
  // standardized `zoom` (Safari 18 / macOS Sequoia, Chromium, WebKitGTK), which
  // resolves viewport units against the UNZOOMED viewport. Legacy WebKit (older
  // macOS) special-cased root `zoom` as page-zoom, which is why it only looked
  // right there. Native zoom reflows correctly on every engine/version; keep CSS
  // `zoom` for the browser (dev/test) build where the native API is absent.
  if (isTauri) {
    style.zoom = ''
    void setWebviewZoom(cfg.uiScale / 100)
  } else {
    style.zoom = cfg.uiScale === 100 ? '' : String(cfg.uiScale / 100)
  }
  root.style.setProperty('--font-sans', FONT_STACKS.sans[cfg.uiFont] ?? FONT_STACKS.sans.plex)
  root.style.setProperty('--font-mono', FONT_STACKS.mono[cfg.monoFont] ?? FONT_STACKS.mono.jetbrains)
  root.style.setProperty('--table-font-size', `${cfg.tableFontSize}px`)
  root.style.setProperty('--table-font', cfg.tableFont === 'mono' ? 'var(--font-mono)' : 'var(--font-sans)')
}
