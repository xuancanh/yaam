// Shared file-preview primitives used by BOTH the desktop file viewer
// (FilesPane) and the mobile companion's rpc-backed viewer (FilesGit):
// extension → kind mapping, image mime table, and highlighted code rendering.
import { highlight, langForFile } from '../core/highlight'

export const IMG_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
}

/** How a viewer should treat one file, by extension. */
export function viewKind(name: string): 'image' | 'pdf' | 'office' | 'text' {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (IMG_MIME[ext]) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return 'office'
  return 'text'
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}

/** Syntax-highlighted source, one div per line — the non-virtualized shared
 *  renderer (the desktop viewer virtualizes its own rows for huge files). */
export function CodeLines({ name, text }: { name: string; text: string }) {
  const lang = langForFile(name)
  return (
    <>
      {text.split('\n').map((l, i) => (
        <div key={i} dangerouslySetInnerHTML={{ __html: highlight(l, lang) || '&nbsp;' }} />
      ))}
    </>
  )
}
