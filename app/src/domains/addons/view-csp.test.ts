import { describe, expect, it } from 'vitest'
import { VIEW_CSP, withViewCsp } from './view-csp'

// SEC-3: the CSP meta must be prepended, never regex-injected into addon
// bytes — an early `<!-- <head> -->` or a `<head>` inside a script string
// used to absorb the meta and leave the real document with no CSP.

const CSP_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/g

/** Index of the first CSP meta in the srcdoc (the one the browser enforces first). */
const firstCspAt = (doc: string) => {
  const m = CSP_RE.exec(doc)
  CSP_RE.lastIndex = 0
  return m ? m.index : -1
}

describe('withViewCsp', () => {
  it('starts with the CSP meta before any addon content, byte-identical HTML after', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>'
    const doc = withViewCsp(html)
    expect(doc.startsWith(VIEW_CSP)).toBe(true)
    expect(doc.slice(VIEW_CSP.length)).toBe(html)
    expect(firstCspAt(doc)).toBe(0)
  })

  it('is not absorbed by a leading <!-- <head> --> comment', () => {
    const html = '<!-- <head> --><html><head><title>x</title></head><body>hi</body></html>'
    const doc = withViewCsp(html)
    expect(firstCspAt(doc)).toBe(0)
    expect(doc.slice(VIEW_CSP.length)).toBe(html)
    // exactly one CSP meta — ours, before the comment
    expect(doc.match(CSP_RE)).toHaveLength(1)
  })

  it('is not absorbed by a <head> inside a script string', () => {
    const html = '<script>const s = "<head><title>pwn</title></head>"</script><html><head></head><body></body></html>'
    const doc = withViewCsp(html)
    expect(firstCspAt(doc)).toBe(0)
    expect(doc.slice(VIEW_CSP.length)).toBe(html)
  })

  it('handles HTML with no <head> at all', () => {
    const html = '<div>just a fragment</div>'
    const doc = withViewCsp(html)
    expect(doc).toBe(VIEW_CSP + html)
    expect(firstCspAt(doc)).toBe(0)
  })

  it('handles empty HTML', () => {
    expect(withViewCsp('')).toBe(VIEW_CSP)
  })

  it('keeps the lockdown directive content (default-src none, data/blob images only)', () => {
    expect(VIEW_CSP).toContain("default-src 'none'")
    expect(VIEW_CSP).toContain("script-src 'unsafe-inline'")
    expect(VIEW_CSP).toContain("style-src 'unsafe-inline'")
    expect(VIEW_CSP).toContain('img-src data: blob:')
    expect(VIEW_CSP).toContain('font-src data:')
  })
})
