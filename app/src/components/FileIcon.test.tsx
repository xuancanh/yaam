// @vitest-environment jsdom
// Outside the desktop app (or when the system icon fails) FileIcon must still
// distinguish file types: known extensions get their language color, unknown
// ones inherit, directories get the folder glyph.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('../core/native', () => ({
  isTauri: false,
  fileIcon: async () => { throw new Error('not on desktop') },
}))

import { FileIcon } from './FileIcon'

afterEach(cleanup)

const glyph = (name: string, isDir = false) =>
  render(createElement(FileIcon, { name, path: `/x/${name}`, isDir })).container

describe('FileIcon glyph fallback', () => {
  it('colors known extensions and case-insensitively', () => {
    expect(glyph('main.ts').querySelector('span')?.style.color).toBe('rgb(49, 120, 198)')
    expect(glyph('APP.TSX').querySelector('span')?.style.color).toBe('rgb(49, 120, 198)')
    expect(glyph('lib.rs').querySelector('span')?.style.color).toBe('rgb(222, 165, 132)')
  })

  it('handles extensionless well-known names and unknown types', () => {
    expect(glyph('Dockerfile').querySelector('span')?.style.color).toBe('rgb(56, 77, 84)')
    expect(glyph('weird.zzz').querySelector('span')?.style.color).toBe('inherit')
    // a leading dot alone is not an extension; .gitignore matches by name
    expect(glyph('.gitignore').querySelector('span')?.style.color).toBe('rgb(241, 78, 50)')
  })

  it('renders a folder glyph (no color span) for directories', () => {
    const c = glyph('src', true)
    expect(c.querySelector('svg')).toBeTruthy()
    expect(c.querySelector('span')).toBeNull()
  })

  it('never renders an img when the system icon is unavailable', () => {
    expect(glyph('main.ts').querySelector('img')).toBeNull()
  })
})
