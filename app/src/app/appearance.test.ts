// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyAppearance, resolveTheme, steppedUiScale } from './appearance'
import { termThemeFor } from '../core/terminals'

describe('applyAppearance', () => {
  it('stamps defaults when no settings are stored', () => {
    applyAppearance(undefined)
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.getAttribute('data-density')).toBe('normal')
    expect(root.style.getPropertyValue('--table-font-size')).toBe('13px')
    expect((root.style as CSSStyleDeclaration & { zoom?: string }).zoom).toBe('')
  })

  it('applies explicit choices', () => {
    applyAppearance({ theme: 'light', density: 'compact', uiScale: 120, uiFont: 'system', monoFont: 'system', tableFontSize: 15, tableFont: 'mono' })
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect((root.style as CSSStyleDeclaration & { zoom?: string }).zoom).toBe('1.2')
    expect(root.style.getPropertyValue('--font-sans')).toContain('system-ui')
    expect(root.style.getPropertyValue('--font-mono')).toContain('Menlo')
    expect(root.style.getPropertyValue('--table-font-size')).toBe('15px')
    expect(root.style.getPropertyValue('--table-font')).toBe('var(--font-mono)')
  })

  it('paper theme stamps its attribute and terminals get a light palette', () => {
    applyAppearance({ theme: 'paper' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper')
    expect(termThemeFor('paper').background).toBe('#F4EFE4')
    expect(termThemeFor('light').foreground).toBe('#24292F')
    expect(termThemeFor('midnight')).toEqual(termThemeFor('dark')) // dark palette shared
  })

  it('resolves the system theme from the OS scheme', () => {
    expect(['light', 'dark']).toContain(resolveTheme('system'))
    expect(resolveTheme('midnight')).toBe('midnight')
  })
})

describe('steppedUiScale', () => {
  it('steps on the 5% grid and clamps at the bounds', () => {
    expect(steppedUiScale(100, 1)).toBe(105)
    expect(steppedUiScale(100, -1)).toBe(95)
    expect(steppedUiScale(undefined, 1)).toBe(105)
    expect(steppedUiScale(138, 1)).toBe(140)
    expect(steppedUiScale(140, 1)).toBe(140)
    expect(steppedUiScale(80, -1)).toBe(80)
  })
  it('snaps off-grid values and resets to 100', () => {
    expect(steppedUiScale(103, 1)).toBe(110)
    expect(steppedUiScale(97, 0)).toBe(100)
  })
})
