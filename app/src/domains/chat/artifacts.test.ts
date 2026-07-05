import { describe, expect, it } from 'vitest'
import { artifactSrcDoc, extractArtifact } from './artifacts'

const bigHtml = `<h1>Report</h1>${'<p>section</p>'.repeat(20)}`
const bigSvg = `<svg viewBox="0 0 100 100">${'<circle cx="5" cy="5" r="2"/>'.repeat(20)}</svg>`

describe('extractArtifact', () => {
  it('finds the LAST renderable fenced block in a reply', () => {
    const text = `Here you go:\n\`\`\`html\n${bigHtml}\n\`\`\`\nAnd a revision:\n\`\`\`html\n${bigHtml}<footer>v2</footer>\n\`\`\``
    const a = extractArtifact(text)!
    expect(a.kind).toBe('html')
    expect(a.source).toContain('v2')
  })

  it('detects fenced svg and bare top-level <svg> documents', () => {
    expect(extractArtifact(`\`\`\`svg\n${bigSvg}\n\`\`\``)?.kind).toBe('svg')
    expect(extractArtifact(`Chart below.\n${bigSvg}`)?.kind).toBe('svg')
  })

  it('ignores small snippets (examples are not products) and other languages', () => {
    expect(extractArtifact('```html\n<b>hi</b>\n```')).toBeNull()
    expect(extractArtifact('```ts\nconst x = 1\n```'.repeat(10))).toBeNull()
    expect(extractArtifact('plain prose, no code')).toBeNull()
  })
})

describe('artifactSrcDoc', () => {
  it('wraps fragments in a shell with a no-network CSP', () => {
    const doc = artifactSrcDoc({ kind: 'html', source: bigHtml })
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain(bigHtml)
    expect(doc.startsWith('<!doctype html>')).toBe(true)
  })

  it('injects the CSP into full documents instead of double-wrapping', () => {
    const full = `<html><head><title>t</title></head><body>${bigHtml}</body></html>`
    const doc = artifactSrcDoc({ kind: 'html', source: full })
    expect(doc).toContain("default-src 'none'")
    expect(doc.match(/<html/gi)).toHaveLength(1)
  })

  it('centers svg artifacts in a minimal shell', () => {
    const doc = artifactSrcDoc({ kind: 'svg', source: bigSvg })
    expect(doc).toContain(bigSvg)
    expect(doc).toContain('place-items:center')
  })
})
