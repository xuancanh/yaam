// Rich office rendering for the file viewer: docx → formatted HTML via
// mammoth, workbooks → real HTML tables via SheetJS. Anything these can't
// handle falls back to the dependency-free text extraction (filetext.ts).
// Both libraries are imported lazily so the viewer bundle stays lean until an
// office file is actually opened.

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

/** Render a workbook (xlsx/xls/csv/ods) to one HTML table per sheet. */
export async function renderWorkbook(bytes: Uint8Array): Promise<OfficeRender> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(bytes, { type: 'array' })
  const sheets: RenderedSheet[] = wb.SheetNames.slice(0, 20).map(name => ({
    name,
    html: XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' }),
  }))
  return { kind: 'sheets', sheets }
}
