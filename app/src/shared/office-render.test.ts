import { describe, it, expect } from 'vitest'
import { renderOdp, renderOdt, renderPptx } from './office-render'

// Build a minimal STORED (uncompressed) zip so the real zip reader + renderers
// run end to end without pulling in a compression dependency. CRC is left 0
// because the reader does not verify it.
function storedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name)
    const data = enc.encode(content)
    const lh = new Uint8Array(30 + nameB.length + data.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameB.length, true)
    lh.set(nameB, 30)
    lh.set(data, 30 + nameB.length)
    locals.push(lh)

    const ch = new Uint8Array(46 + nameB.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameB.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nameB, 46)
    centrals.push(ch)
    offset += lh.length
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...centrals, eocd]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

const slideXml = (paras: string[]) =>
  `<p:sld xmlns:a="a"><p:cSld><p:spTree>${paras
    .map(t => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`)
    .join('')}</p:spTree></p:cSld></p:sld>`

describe('renderPptx', () => {
  it('orders slides by the presentation relationships and pulls text', async () => {
    const zip = storedZip({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slideXml(['First slide', 'a bullet']),
      'ppt/slides/slide2.xml': slideXml(['Second slide']),
    })
    const out = await renderPptx(zip)
    expect(out.kind).toBe('slides')
    expect(out.slides).toHaveLength(2)
    expect(out.slides![0].title).toBe('First slide')
    expect(out.slides![0].html).toContain('<h2>First slide</h2>')
    expect(out.slides![0].html).toContain('<p>a bullet</p>')
    expect(out.slides![1].title).toBe('Second slide')
  })

  it('falls back to numeric slide order and escapes text', async () => {
    const zip = storedZip({
      'ppt/presentation.xml': '<p:presentation></p:presentation>',
      'ppt/slides/slide1.xml': slideXml(['1 < 2 & "x"']),
    })
    const out = await renderPptx(zip)
    expect(out.slides).toHaveLength(1)
    expect(out.slides![0].html).toContain('1 &lt; 2 &amp; &quot;x&quot;')
    expect(out.slides![0].html).not.toContain('<h2>1 < 2')
  })

  it('rejects a non-pptx archive', async () => {
    await expect(renderPptx(storedZip({ 'foo.txt': 'x' }))).rejects.toThrow(/only \.pptx/)
  })
})

describe('renderOdp', () => {
  it('renders one card per draw:page', async () => {
    const content = '<office:document-content><office:body><office:presentation>'
      + '<draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Slide one</text:p></draw:text-box></draw:frame></draw:page>'
      + '<draw:page draw:name="p2"><text:p>Slide two</text:p><text:p>more</text:p></draw:page>'
      + '</office:presentation></office:body></office:document-content>'
    const out = await renderOdp(storedZip({ 'content.xml': content }))
    expect(out.kind).toBe('slides')
    expect(out.slides).toHaveLength(2)
    expect(out.slides![0].html).toContain('<h2>Slide one</h2>')
    expect(out.slides![1].html).toContain('<p>more</p>')
  })
})

describe('renderOdt', () => {
  it('turns headings and paragraphs into escaped HTML', async () => {
    const content = '<office:document-content><office:body><office:text>'
      + '<text:h text:outline-level="1">Title &amp; intro</text:h>'
      + '<text:p>Hello <text:span>world</text:span></text:p>'
      + '<text:p></text:p>'
      + '</office:text></office:body></office:document-content>'
    const out = await renderOdt(storedZip({ 'content.xml': content }))
    expect(out.kind).toBe('docx')
    expect(out.html).toContain('<h1>Title &amp; intro</h1>')
    expect(out.html).toContain('<p>Hello world</p>')
    // empty paragraph is dropped
    expect(out.html!.match(/<p>/g)).toHaveLength(1)
  })
})
