// Minimal ZIP reader — enough to open Office documents (docx/xlsx/pptx are
// zip archives of XML) without adding a dependency. Parses the central
// directory and inflates entries with the browser's DecompressionStream.

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflate */
  method: number
  compressedSize: number
  size: number
  /** offset of the local file header */
  offset: number
}

/** Locate the end-of-central-directory record and list the archive entries. */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD signature 0x06054b50, scanned backwards past any trailing comment
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true) // central directory offset
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const size = view.getUint32(p + 24, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const offset = view.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    entries.push({ name, method, compressedSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Inflate raw deflate data via the platform DecompressionStream. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/** Extract one entry's bytes (stored or deflated). */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`)
  const nameLen = view.getUint16(entry.offset + 26, true)
  const extraLen = view.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLen + extraLen
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return await inflateRaw(data)
  throw new Error(`unsupported zip compression method ${entry.method}`)
}

/** Read one entry as UTF-8 text, or null when it is absent. */
export async function readZipText(bytes: Uint8Array, entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find(e => e.name === name)
  if (!entry) return null
  return new TextDecoder().decode(await readZipEntry(bytes, entry))
}
