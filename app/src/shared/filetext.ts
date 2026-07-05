// Best-effort text extraction from the file formats working users actually
// drop on a chat: Office documents (zip+XML), PDFs (Flate streams + text
// operators), images (passed through as vision blocks), and plain text.
// Dependency-free: zip via shared/zip, inflate via DecompressionStream.
import { listZipEntries, readZipText } from './zip'

export type ExtractedKind = 'text' | 'image' | 'binary'

export interface Extracted {
  kind: ExtractedKind
  /** extracted text (kind text) */
  text?: string
  /** media type (kind image) */
  mediaType?: string
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => {
  if (XML_ENTITIES[e]) return XML_ENTITIES[e]
  if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16) || 63)
  if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10) || 63)
  return m
})

// ---------------------------------------------------------------- office

async function docxText(bytes: Uint8Array): Promise<string> {
  const entries = listZipEntries(bytes)
  const xml = await readZipText(bytes, entries, 'word/document.xml')
  if (!xml) return '(docx has no word/document.xml)'
  return decodeXml(
    xml
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim()
}

/** shared strings + per-sheet cell values → TSV-ish text per sheet */
async function xlsxText(bytes: Uint8Array): Promise<string> {
  const entries = listZipEntries(bytes)
  const sharedXml = await readZipText(bytes, entries, 'xl/sharedStrings.xml')
  const shared: string[] = []
  if (sharedXml) {
    for (const si of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1]))
      shared.push(texts.join(''))
    }
  }
  const sheets = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const out: string[] = []
  for (const sheet of sheets.slice(0, 10)) {
    const xml = await readZipText(bytes, entries, sheet.name)
    if (!xml) continue
    const rows: string[] = []
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const c of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = c[1]
        const inner = c[2]
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1]
          ?? inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] // inlineStr
          ?? ''
        const isShared = /t="s"/.test(attrs)
        cells.push(decodeXml(isShared ? shared[Number(v)] ?? '' : v))
      }
      rows.push(cells.join('\t'))
      if (rows.length >= 500) { rows.push('… (rows truncated)'); break }
    }
    out.push(`--- ${sheet.name.replace('xl/worksheets/', '')} ---\n${rows.join('\n')}`)
  }
  return out.join('\n\n').trim() || '(empty workbook)'
}

async function pptxText(bytes: Uint8Array): Promise<string> {
  const entries = listZipEntries(bytes)
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const out: string[] = []
  for (const slide of slides.slice(0, 60)) {
    const xml = await readZipText(bytes, entries, slide.name)
    if (!xml) continue
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => decodeXml(m[1]))
    out.push(`--- slide ${slide.name.match(/\d+/)?.[0]} ---\n${texts.join('\n')}`)
  }
  return out.join('\n\n').trim() || '(no slide text)'
}

// ---------------------------------------------------------------- pdf

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream('deflate')
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

/** unescape a PDF literal string: \( \) \\ \n \t and octal escapes */
function pdfUnescape(s: string): string {
  return s.replace(/\\(\d{1,3}|.)/g, (_, esc: string) => {
    if (/^\d/.test(esc)) return String.fromCharCode(parseInt(esc, 8) & 0xff)
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[esc] ?? esc
  })
}

/** collect text-showing operators (Tj, TJ, ', ") from one content stream */
function pdfStreamText(src: string): string {
  const parts: string[] = []
  // (string) Tj  |  (string) '  |  (string) "
  for (const m of src.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g)) parts.push(pdfUnescape(m[1]))
  // [ (a) -120 (b) ] TJ
  for (const m of src.matchAll(/\[((?:\((?:\\.|[^\\()])*\)|[^\]])*)\]\s*TJ/g)) {
    const strs = [...m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map(x => pdfUnescape(x[1]))
    parts.push(strs.join(''))
  }
  return parts.join(' ')
}

/** Best-effort PDF text: inflate Flate content streams and read text operators.
 *  Handles the common case (uncompressed xref, Flate streams, simple fonts);
 *  image-only or exotic PDFs yield little — callers should say so. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const latin = new TextDecoder('latin1').decode(bytes)
  const out: string[] = []
  const streamRe = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(latin)) !== null) {
    const start = m.index + m[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    const dictStart = latin.lastIndexOf('<<', m.index)
    const dict = dictStart >= 0 ? latin.slice(dictStart, m.index) : ''
    const raw = bytes.subarray(start, end)
    let text: string | null = null
    if (/\/FlateDecode/.test(dict)) {
      const inflated = await inflate(raw)
      if (inflated) text = new TextDecoder('latin1').decode(inflated)
    } else if (!/\/Filter/.test(dict)) {
      text = latin.slice(start, end)
    }
    if (text && /\b(Tj|TJ|BT)\b/.test(text)) {
      const t = pdfStreamText(text)
      if (t.trim()) out.push(t)
    }
    streamRe.lastIndex = end
  }
  const joined = out.join('\n').replace(/[ \t]{2,}/g, ' ').trim()
  return joined || '(no extractable text — the PDF may be scanned images)'
}

// ---------------------------------------------------------------- entry

/** Decode base64 into bytes (no browser text-encoding assumptions). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Route one file to its extractor by extension (with a UTF-8 fallback). */
export async function extractFileText(name: string, bytes: Uint8Array): Promise<Extracted> {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (IMAGE_TYPES[ext]) return { kind: 'image', mediaType: IMAGE_TYPES[ext] }
  try {
    if (ext === 'pdf') return { kind: 'text', text: await pdfText(bytes) }
    if (ext === 'docx') return { kind: 'text', text: await docxText(bytes) }
    if (ext === 'xlsx') return { kind: 'text', text: await xlsxText(bytes) }
    if (ext === 'pptx') return { kind: 'text', text: await pptxText(bytes) }
  } catch (e) {
    return { kind: 'text', text: `(could not parse ${ext}: ${e instanceof Error ? e.message : e})` }
  }
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { kind: 'binary' }
  }
}
