// Rich office rendering for the file viewer: docx → formatted HTML via
// mammoth, workbooks → bounded ZIP/XML parsing. Anything these can't handle
// falls back to the dependency-free text extraction (filetext.ts).
import { listZipEntries, readZipEntry, readZipText } from './zip'
import type { ZipEntry } from './zip'

export interface RenderedSheet {
  name: string
  html: string
}

export interface RenderedSlide {
  /** first line of the slide, used for the picker tooltip */
  title?: string
  /** the slide body as escaped HTML (headings, text, images) */
  html: string
}

export interface OfficeRender {
  kind: 'docx' | 'sheets' | 'slides'
  /** docx / odt: one HTML document body */
  html?: string
  /** workbooks: one HTML table per sheet */
  sheets?: RenderedSheet[]
  /** presentations: one card per slide */
  slides?: RenderedSlide[]
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

// ---- presentations (.pptx / .odp) and text documents (.odt) ----

const MAX_SLIDES = 100
const MAX_IMAGES_PER_SLIDE = 8
const MAX_IMAGE_BYTES = 3_000_000

/** Resolve an OOXML relationship target (e.g. "../media/image1.png") against the
 *  part that referenced it, returning a zip-root-relative path. */
function resolveRel(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const baseDir = basePath.slice(0, basePath.lastIndexOf('/'))
  const stack: string[] = []
  for (const part of `${baseDir}/${target}`.split('/')) {
    if (part === '..') stack.pop()
    else if (part !== '.' && part !== '') stack.push(part)
  }
  return stack.join('/')
}

function imageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'png' ? 'image/png'
    : ext === 'gif' ? 'image/gif'
    : ext === 'svg' ? 'image/svg+xml'
    : ext === 'bmp' ? 'image/bmp'
    : ext === 'webp' ? 'image/webp'
    : 'image/jpeg'
}

/** Read one zip entry as a bounded data: URI, or null if absent or too large. */
async function zipImageDataUri(bytes: Uint8Array, entries: ZipEntry[], path: string): Promise<string | null> {
  const entry = entries.find(e => e.name === path)
  if (!entry || entry.size > MAX_IMAGE_BYTES) return null
  const data = await readZipEntry(bytes, entry).catch(() => null)
  if (!data) return null
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return `data:${imageMime(path)};base64,${btoa(bin)}`
}

/** One slide card: first paragraph as a heading, the rest as text, images after. */
function slideCard(paras: string[], imgs: string[]): string {
  const body = paras.length
    ? paras.map((t, i) => (i === 0 ? `<h2>${escapeHtml(t)}</h2>` : `<p>${escapeHtml(t)}</p>`)).join('')
    : '<p class="slide-empty">(no text on this slide)</p>'
  const pics = imgs.map(src => `<img src="${src}" alt="" />`).join('')
  return `<div class="slidecard">${body}${pics}</div>`
}

/** Render a .pptx into per-slide cards (text runs + embedded images). */
export async function renderPptx(bytes: Uint8Array): Promise<OfficeRender> {
  const entries = listZipEntries(bytes)
  const pres = await readZipText(bytes, entries, 'ppt/presentation.xml')
  if (!pres) throw new Error('unsupported presentation format (only .pptx is supported)')

  const rels = await readZipText(bytes, entries, 'ppt/_rels/presentation.xml.rels')
  const relMap = new Map<string, string>()
  for (const rel of rels?.matchAll(/<Relationship\b([^>]*)\/?\s*>/g) ?? []) {
    const id = rel[1].match(/\bId="([^"]+)"/)?.[1]
    const target = rel[1].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && target && !/^https?:/i.test(target)) relMap.set(id, resolveRel('ppt/presentation.xml', target))
  }
  let ordered = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)]
    .map(m => relMap.get(m[1]))
    .filter((p): p is string => !!p && /slide\d+\.xml$/.test(p))
  if (!ordered.length) {
    ordered = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  const slides: RenderedSlide[] = []
  for (const path of ordered.slice(0, MAX_SLIDES)) {
    const xml = await readZipText(bytes, entries, path)
    if (!xml) continue
    const paras: string[] = []
    for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const text = [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(t => decodeXml(t[1])).join('')
      if (text.trim()) paras.push(text)
    }
    const imgs = await pptxSlideImages(bytes, entries, path, xml)
    slides.push({ title: paras[0], html: slideCard(paras, imgs) })
  }
  return { kind: 'slides', slides }
}

/** Data URIs for the images a .pptx slide embeds via <a:blip r:embed="…">. */
async function pptxSlideImages(bytes: Uint8Array, entries: ZipEntry[], slidePath: string, xml: string): Promise<string[]> {
  const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels')
  const rels = await readZipText(bytes, entries, relsPath)
  if (!rels) return []
  const map = new Map<string, string>()
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const id = rel[1].match(/\bId="([^"]+)"/)?.[1]
    const target = rel[1].match(/\bTarget="([^"]+)"/)?.[1]
    if (id && target && !/^https?:/i.test(target)) map.set(id, resolveRel(slidePath, target))
  }
  const out: string[] = []
  for (const blip of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
    const path = map.get(blip[1])
    if (!path) continue
    const uri = await zipImageDataUri(bytes, entries, path)
    if (uri) out.push(uri)
    if (out.length >= MAX_IMAGES_PER_SLIDE) break
  }
  return out
}

// ODF (.odt / .odp) inline text: turn structural whitespace tags into their
// characters, then drop the remaining span/formatting tags.
function odfInline(fragment: string): string {
  const flattened = fragment
    .replace(/<text:tab\b[^>]*\/?>/g, '\t')
    .replace(/<text:line-break\b[^>]*\/?>/g, '\n')
    .replace(/<text:s\b[^>]*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
  return decodeXml(flattened)
}

/** Render an OpenDocument text file (.odt) to HTML, like the docx path. */
export async function renderOdt(bytes: Uint8Array): Promise<OfficeRender> {
  const entries = listZipEntries(bytes)
  const content = await readZipText(bytes, entries, 'content.xml')
  if (!content) throw new Error('unsupported document (no content.xml)')
  const body = content.match(/<office:text\b[^>]*>([\s\S]*?)<\/office:text>/)?.[1] ?? content
  const out: string[] = []
  for (const m of body.matchAll(/<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1>/g)) {
    const text = odfInline(m[3])
    if (m[1] === 'h') {
      const level = Math.min(4, Math.max(1, Number(m[2].match(/text:outline-level="(\d+)"/)?.[1] ?? 2)))
      if (text.trim()) out.push(`<h${level}>${escapeHtml(text)}</h${level}>`)
    } else if (text.trim()) {
      out.push(`<p>${escapeHtml(text)}</p>`)
    }
  }
  return { kind: 'docx', html: out.join('\n') || '<p>(empty document)</p>' }
}

/** Render an OpenDocument presentation (.odp) into per-slide cards. */
export async function renderOdp(bytes: Uint8Array): Promise<OfficeRender> {
  const entries = listZipEntries(bytes)
  const content = await readZipText(bytes, entries, 'content.xml')
  if (!content) throw new Error('unsupported presentation (no content.xml)')
  const slides: RenderedSlide[] = []
  for (const page of content.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)) {
    const frag = page[1]
    const paras = [...frag.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
      .map(p => odfInline(p[1]))
      .filter(t => t.trim())
    const imgs: string[] = []
    for (const img of frag.matchAll(/<draw:image\b[^>]*xlink:href="([^"]+)"/g)) {
      const uri = await zipImageDataUri(bytes, entries, img[1].replace(/^\.\//, ''))
      if (uri) imgs.push(uri)
      if (imgs.length >= MAX_IMAGES_PER_SLIDE) break
    }
    slides.push({ title: paras[0], html: slideCard(paras, imgs) })
    if (slides.length >= MAX_SLIDES) break
  }
  return { kind: 'slides', slides }
}
