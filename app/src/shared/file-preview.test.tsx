// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { CodeLines, DiffLines, isWorkbook, viewKind } from './file-preview'
import { HL_COLORS } from '../core/highlight'

afterEach(cleanup)

describe('viewKind / isWorkbook', () => {
  it('classifies files by extension', () => {
    expect(viewKind('a.png')).toBe('image')
    expect(viewKind('a.pdf')).toBe('pdf')
    expect(viewKind('a.xlsx')).toBe('office')
    expect(viewKind('a.html')).toBe('html')
    expect(viewKind('a.ts')).toBe('text')
  })
  it('only treats .xlsx as a richly renderable workbook', () => {
    expect(isWorkbook('sheet.xlsx')).toBe(true)
    expect(isWorkbook('SHEET.XLSX')).toBe(true)
    expect(isWorkbook('old.xls')).toBe(false)
    expect(isWorkbook('notes.txt')).toBe(false)
  })
})

describe('CodeLines', () => {
  it('syntax-highlights source, one row per line', () => {
    const { container } = render(createElement(CodeLines, { name: 'x.ts', text: 'const a = 1\nfoo()' }))
    const rows = container.querySelectorAll('div')
    expect(rows.length).toBe(2)
    // the JS keyword `const` gets the keyword color
    expect(container.innerHTML).toContain(HL_COLORS.keyword)
  })
})

describe('DiffLines', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,2 +1,2 @@',
    '-const a = 1',
    '+const a = 2',
    ' unchanged',
  ].join('\n')

  it('colors +/- markers and highlights the code tokens', () => {
    const { container } = render(createElement(DiffLines, { diff, name: 'x.ts' }))
    const html = container.innerHTML
    // added line marker tinted green, removed line marker tinted red
    expect(html).toContain('var(--green)')
    expect(html).toContain('var(--red-soft)')
    // hunk header tinted with the accent
    expect(html).toContain('var(--accent)')
    // the `const` keyword inside the diff body is still syntax-highlighted
    expect(html).toContain(HL_COLORS.keyword)
  })

  it('renders one row per diff line', () => {
    const { container } = render(createElement(DiffLines, { diff, name: 'x.ts' }))
    expect(container.querySelectorAll('pre > div').length).toBe(diff.split('\n').length)
  })
})
