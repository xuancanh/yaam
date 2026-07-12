import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MasterMark } from './ui'

describe('MasterMark logo tint', () => {
  it('tints the gradient and glow with a workspace color', () => {
    const html = renderToStaticMarkup(<MasterMark color="#3DDC97" />)
    expect(html).toContain('#3DDC97')         // gradient start = the chosen color
    expect(html).toContain('rgba(61,220,151') // soft + glow derived via hexToRgba
    expect(html).not.toContain('var(--accent)')
  })

  it('falls back to the yellow accent when no color is set', () => {
    const html = renderToStaticMarkup(<MasterMark />)
    expect(html).toContain('var(--accent)')
    expect(html).toContain('245,196,81') // the default yellow glow/soft
  })
})
