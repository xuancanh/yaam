// Shared file-preview primitives used by BOTH the desktop file viewer
// (FilesPane) and the mobile companion's rpc-backed viewer (FilesGit):
// extension → kind mapping, image mime table, and highlighted code/diff
// rendering.
import { useMemo } from 'react'
import { highlight, langForFile } from '../core/highlight'

export const IMG_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
}

/** How a viewer should treat one file, by extension. */
export function viewKind(name: string): 'image' | 'pdf' | 'office' | 'html' | 'text' {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (IMG_MIME[ext]) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx' || ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'pptx') return 'office'
  if (ext === 'html' || ext === 'htm') return 'html'
  return 'text'
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name)
}

/** True for spreadsheet formats the dependency-free workbook renderer handles. */
export function isWorkbook(name: string): boolean {
  return /\.xlsx$/i.test(name)
}

/** Syntax-highlighted source, one div per line — the non-virtualized shared
 *  renderer (the desktop viewer virtualizes its own rows for huge files).
 *  Highlighting is memoized so a re-render from unrelated state (e.g. a live
 *  snapshot push on mobile) doesn't re-run the regex over every line. */
export function CodeLines({ name, text }: { name: string; text: string }) {
  const html = useMemo(() => {
    const lang = langForFile(name)
    return text.split('\n').map(l => highlight(l, lang) || '&nbsp;')
  }, [name, text])
  return (
    <>
      {html.map((h, i) => <div key={i} dangerouslySetInnerHTML={{ __html: h }} />)}
    </>
  )
}

/** One rendered diff line: chrome (meta/hunk) stays literal; code lines keep a
 *  colored +/-/space marker with syntax-highlighted tokens after it. */
interface DiffLine { plain: boolean; markColor: string; bg: string; mark?: string; html: string }

/** Colored unified diff with syntax-highlighted tokens — the SAME rendering the
 *  desktop diff view uses, shared with the mobile companion so both read alike.
 *  `name` picks the highlighter; the highlighting is memoized on the diff text
 *  so a static diff isn't re-highlighted when a parent re-renders. */
export function DiffLines({ diff, name }: { diff: string; name?: string }) {
  const lines = useMemo<DiffLine[]>(() => {
    const lang = name ? langForFile(name) : 'text'
    return diff.split('\n').map(line => {
      const isMeta = line.startsWith('+++') || line.startsWith('---')
      const isAdd = line.startsWith('+') && !isMeta
      const isDel = line.startsWith('-') && !isMeta
      const isHunk = line.startsWith('@@')
      const markColor = isMeta ? 'var(--text)' : isAdd ? 'var(--green)' : isDel ? 'var(--red-soft)' : isHunk ? 'var(--accent)' : 'var(--mut)'
      const bg = isAdd ? 'rgba(61,220,151,.06)' : isDel ? 'rgba(255,92,92,.06)' : 'transparent'
      // meta/hunk/blank lines are diff chrome — literal, no token highlight
      if (isMeta || isHunk || !line) return { plain: true, markColor, bg, html: line || ' ' }
      const mark = isAdd || isDel || line.startsWith(' ') ? line.slice(0, 1) : ''
      const code = mark ? line.slice(1) : line
      return { plain: false, markColor, bg, mark, html: highlight(code, lang) || ' ' }
    })
  }, [diff, name])
  return (
    <pre className="filetext mono" style={{ margin: 0 }}>
      {lines.map((l, i) => l.plain ? (
        <div key={i} style={{ color: l.markColor, background: l.bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.html}</div>
      ) : (
        <div key={i} style={{ background: l.bg, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <span style={{ color: l.markColor, userSelect: 'none' }}>{l.mark}</span>
          <span dangerouslySetInnerHTML={{ __html: l.html }} />
        </div>
      ))}
    </pre>
  )
}
