import { describe, expect, it } from 'vitest'
import { extractFileText } from './filetext'
import { renderWorkbook } from './office-render'
import { listZipEntries } from './zip'

/** Build a minimal ZIP (stored entries, no compression) for extractor tests. */
function makeStoredZip(entries: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff])
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff])
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let p = 0
    for (const part of parts) { out.set(part, p); p += part.length }
    return out
  }
  for (const e of entries) {
    const name = enc.encode(e.name)
    const data = enc.encode(e.text)
    const local = cat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data)
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name))
    chunks.push(local)
    offset += local.length
  }
  const centralBytes = cat(...central)
  const eocd = cat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(offset), u16(0))
  return cat(...chunks, centralBytes, eocd)
}

describe('extractFileText', () => {
  it('extracts paragraph text from a docx', async () => {
    const zip = makeStoredZip([{
      name: 'word/document.xml',
      text: '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>W&amp;rld</w:t></w:r></w:p></w:body></w:document>',
    }])
    const res = await extractFileText('memo.docx', zip)
    expect(res.kind).toBe('text')
    expect(res.text).toBe('Hello\nW&rld')
  })

  it('extracts shared-string cells from an xlsx', async () => {
    const zip = makeStoredZip([
      { name: 'xl/sharedStrings.xml', text: '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>' },
    ])
    const res = await extractFileText('sheet.xlsx', zip)
    expect(res.kind).toBe('text')
    expect(res.text).toContain('Name\t42')
    expect(res.text).toContain('Ada')
  })

  it('renders workbook sheets in workbook order and escapes cell HTML', async () => {
    const zip = makeStoredZip([
      { name: 'xl/workbook.xml', text: '<workbook><sheets><sheet name="Summary &amp; notes" r:id="r2"/><sheet name="Raw" r:id="r1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', text: '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>' },
      { name: 'xl/sharedStrings.xml', text: '<sst><si><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></si></sst>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><sheetData><row><c><v>7</v></c></row></sheetData></worksheet>' },
      { name: 'xl/worksheets/sheet2.xml', text: '<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>' },
    ])
    const rendered = await renderWorkbook(zip)
    expect(rendered.sheets?.map(s => s.name)).toEqual(['Summary & notes', 'Raw'])
    expect(rendered.sheets?.[0].html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(rendered.sheets?.[0].html).not.toContain('<script>')
    expect(rendered.sheets?.[1].html).toContain('<td>7</td>')
  })

  it('rejects zip entries whose declared expansion exceeds the safety limit', () => {
    const zip = makeStoredZip([{ name: 'tiny.txt', text: 'x' }])
    const central = zip.findIndex((_, i) => i + 3 < zip.length
      && zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02)
    new DataView(zip.buffer).setUint32(central + 24, 64 * 1024 * 1024 + 1, true)
    expect(() => listZipEntries(zip)).toThrow(/64 MB safety limit/)
  })

  it('routes images to vision and binaries to a fallback', async () => {
    const png = await extractFileText('shot.png', new Uint8Array([137, 80]))
    expect(png).toEqual({ kind: 'image', mediaType: 'image/png' })
    const bin = await extractFileText('blob.dat', new Uint8Array([0xff, 0xfe, 0x00, 0x80]))
    expect(bin.kind).toBe('binary')
  })

  it('decodes plain UTF-8 text files', async () => {
    const res = await extractFileText('note.txt', new TextEncoder().encode('héllo'))
    expect(res).toEqual({ kind: 'text', text: 'héllo' })
  })

  it('reads text operators from an uncompressed pdf stream', async () => {
    const pdf = new TextEncoder().encode(
      '%PDF-1.4\n1 0 obj << /Length 44 >>\nstream\nBT /F1 12 Tf (Hello) Tj [(, )( world)] TJ ET\nendstream\nendobj\n',
    )
    const res = await extractFileText('doc.pdf', pdf)
    expect(res.kind).toBe('text')
    expect(res.text).toContain('Hello')
    expect(res.text).toContain(', world')
  })
})
