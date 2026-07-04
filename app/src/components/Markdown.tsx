import type { ReactNode } from 'react'

// Minimal dependency-free markdown renderer for chat bubbles: fenced code,
// headings, bullet/numbered lists, bold/italic/inline code, and links.
// Everything is emitted as React elements — no HTML injection surface.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

/** Render inline markdown spans within one line of text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push(text.slice(last, i))
    const tok = m[0]
    const key = `${keyBase}-${k++}`
    if (tok.startsWith('`')) {
      out.push(
        <code key={key} className="mono" style={{ fontSize: '0.92em', background: 'rgba(255,255,255,.07)', border: '1px solid var(--line2)', borderRadius: 4, padding: '0 4px' }}>
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('**')) {
      out.push(<b key={key} style={{ color: 'var(--text)' }}>{tok.slice(2, -2)}</b>)
    } else if (tok.startsWith('*')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>)
    } else {
      const label = tok.slice(1, tok.indexOf(']'))
      const href = tok.slice(tok.indexOf('](') + 2, -1)
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          {label}
        </a>,
      )
    }
    last = i + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Join lines of one paragraph with <br/> separators. */
function withBreaks(lines: string[], keyBase: string): ReactNode[] {
  return lines.flatMap((l, i) => (i ? [<br key={`${keyBase}-br${i}`} />, ...inline(l, `${keyBase}-l${i}`)] : inline(l, `${keyBase}-l${i}`)))
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  let i = 0
  let k = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) { i++; continue }

    // fenced code block
    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++])
      i++
      blocks.push(
        <pre key={`b${k++}`} className="mono" style={{
          background: '#07080B', border: '1px solid var(--line)', borderRadius: 8,
          padding: '8px 11px', fontSize: '0.9em', lineHeight: 1.5, overflowX: 'auto',
          whiteSpace: 'pre', margin: '6px 0',
        }}>
          {buf.join('\n')}
        </pre>,
      )
      continue
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      blocks.push(
        <div key={`b${k++}`} style={{ fontWeight: 700, color: 'var(--text)', fontSize: h[1].length <= 2 ? '1.05em' : '1em', margin: '8px 0 3px' }}>
          {inline(h[2], `h${k}`)}
        </div>,
      )
      i++
      continue
    }

    // bullet / numbered list
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: { marker: string; text: string }[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)$/)!
        items.push({ marker: /\d/.test(m[1]) ? m[1] : '•', text: m[2] })
        i++
      }
      blocks.push(
        <div key={`b${k++}`} style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {items.map((it, j) => (
            <div key={j} style={{ display: 'flex', gap: 7 }}>
              <span style={{ color: 'var(--dim)', flexShrink: 0 }}>{it.marker}</span>
              <span style={{ minWidth: 0 }}>{inline(it.text, `li${k}-${j}`)}</span>
            </div>
          ))}
        </div>,
      )
      continue
    }

    // paragraph: consume until blank line or another block start
    const buf: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
      buf.push(lines[i++])
    }
    blocks.push(<div key={`b${k++}`} style={{ margin: '3px 0' }}>{withBreaks(buf, `p${k}`)}</div>)
  }

  return <>{blocks}</>
}
