// Rich office rendering for the file viewer: docx → formatted HTML via
// mammoth, workbooks → bounded ZIP/XML parsing. Anything these can't handle
// falls back to the dependency-free text extraction (filetext.ts).
import { listZipEntries, readZipText } from './zip'

export interface RenderedSheet {
  name: string
  html: string
}

export interface OfficeRender {
  kind: 'docx' | 'sheets'
  /** docx: one HTML document body */
  html?: string
  /** workbooks: one HTML table per sheet */
  sheets?: RenderedSheet[]
  /** conversion warnings worth surfacing (unsupported elements, …) */
  notes?: string[]
}

/** Render a .docx to HTML (headings, lists, tables, bold/italic survive). */
export async function renderDocx(bytes: Uint8Array): Promise<OfficeRender> {
  const mammoth = await import('mammoth')
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const res = await mammoth.convertToHtml({ arrayBuffer: buf })
  return {
    kind: 'docx',
    html: res.value,
    notes: res.messages.slice(0, 5).map(m => m.message),
  }
}

/** Render a bounded .xlsx workbook to escaped HTML tables. */
export async function renderWorkbook(bytes: Uint8Array): Promise<OfficeRender> {
  const entries = listZipEntries(bytes)
  const workbook = await readZipText(bytes, entries, 'xl/workbook.xml')
  if (!workbook) throw new Error('unsupported workbook format (only .xlsx is supported)')

  const sharedXml = await readZipText(bytes, entries, 'xl/sharedStrings.xml')
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(si =>
        [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join(''))
    : []
  const rels = await readZipText(bytes, entries, 'xl/_rels/workbook.xml.rels')
  const targets = new Map<string, string>()
  for (const rel of rels?.matchAll(/<Relationship\b([^>]*)\/?\s*>/g) ?? []) {
    const id = rel[1].match(/\bId="([^"]+)"/)?.[1]
    const target = rel[1].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && target && !target.includes('..')) targets.set(id, `xl/${target.replace(/^\//, '')}`)
  }
  const sheetDefs = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)].map((sheet, index) => ({
    name: decodeXml(sheet[1].match(/\bname="([^"]*)"/)?.[1] ?? `Sheet ${index + 1}`),
    path: targets.get(sheet[1].match(/\br:id="([^"]+)"/)?.[1] ?? ''),
  }))
  const fallbackEntries = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const sheets: RenderedSheet[] = []
  const selected = sheetDefs.length
    ? sheetDefs.map((sheet, index) => ({ name: sheet.name, path: sheet.path ?? fallbackEntries[index]?.name }))
    : fallbackEntries.map((entry, index) => ({ name: `Sheet ${index + 1}`, path: entry.name }))
  for (const sheet of selected.slice(0, 20)) {
    if (!sheet.path) continue
    const xml = await readZipText(bytes, entries, sheet.path)
    if (!xml) continue
    const rows: string[] = []
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1]
          ?? cell[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1]
          ?? ''
        const decoded = /\bt="s"/.test(cell[1]) ? shared[Number(value)] ?? '' : decodeXml(value)
        cells.push(`<td>${escapeHtml(decoded)}</td>`)
        if (cells.length >= 256) break
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
      if (rows.length >= 2_000) {
        rows.push('<tr><td>… rows truncated</td></tr>')
        break
      }
    }
    sheets.push({
      name: sheet.name,
      html: `<table><tbody>${rows.join('')}</tbody></table>`,
    })
  }
  return { kind: 'sheets', sheets }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXml(value: string): string {
  return value.replace(/&(#?\w+);/g, (match, entity: string) => {
    if (XML_ENTITIES[entity]) return XML_ENTITIES[entity]
    if (/^#x[\da-f]+$/i.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (/^#\d+$/.test(entity)) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return match
  })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
