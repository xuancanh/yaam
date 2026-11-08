// Pure file-path detection for terminal ctrl/cmd+click links. Finds path-like
// tokens in one rendered terminal line and reports where they sit so the xterm
// link provider can underline them. URLs are excluded here; urlLinksAt (below)
// owns those. Pure string logic, unit-testable without xterm.

export interface PathMatch {
  /** 0-based index of the whole underlined token in the line */
  index: number
  /** length of the underlined token (includes any :line[:col] suffix) */
  length: number
  /** the openable path — :line[:col] suffix and trailing punctuation stripped */
  path: string
  /** 1-based line number parsed from a :line[:col] suffix, if present */
  line?: number
}

// Three shapes, in priority order:
//  1. anchored: starts with / ./ ../ or ~/  (absolute, home, or dot-relative)
//  2. relative with a slash: src/foo/bar.ts, a/b/c
//  3. bare filename with an extension: package.json, main.rs
// All may carry a :line or :line:col suffix. The char class deliberately
// excludes shell/markup delimiters so quotes and brackets end a match.
const P = String.raw`[\w.@+%-]`
const PATH_RE = new RegExp(
  String.raw`(?:~/|\.{1,2}/|/)(?:${P}+/)*${P}+/?` + // 1. anchored
  String.raw`|${P}+(?:/${P}+)+` +                   // 2. relative with slash
  String.raw`|${P}+\.[A-Za-z][A-Za-z0-9]{0,7}`,     // 3. bare file.ext
  'g',
)

/** Chars that may sit directly before a path start (or the line start). */
const BOUNDARY_BEFORE = new Set([' ', '\t', '"', "'", '`', '(', '[', '<', '=', ','])

/** Find every openable file-path token in one terminal line. */
export function filePathMatches(text: string): PathMatch[] {
  const out: PathMatch[] = []
  PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PATH_RE.exec(text))) {
    let tok = m[0]
    const start = m.index
    // must sit on a word boundary — rejects the "//host/path" tail of a URL
    // (preceded by ':' or '/') and tokens glued to other text
    const before = start === 0 ? '' : text[start - 1]
    if (before && !BOUNDARY_BEFORE.has(before)) continue
    // drop trailing sentence punctuation ("see src/app.ts.")
    tok = tok.replace(/[.,;]+$/, '')
    if (!tok || tok === '.' || tok === '..' || tok === '/' || tok === '~/') continue
    // a :line[:col] suffix immediately after the token is part of the link
    const suffix = /^:(\d+)(?::\d+)?/.exec(text.slice(start + tok.length))
    const line = suffix ? parseInt(suffix[1], 10) : undefined
    const full = tok + (suffix ? suffix[0] : '')
    // needs a path signal: a slash, a dot-extension, or a home anchor —
    // rejects bare words that only matched via the relative alternation
    if (!/[/~]/.test(tok) && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok)) continue
    out.push({ index: start, length: full.length, path: tok, line })
  }
  return out
}

/** Resolve a matched path against the session cwd (kept pure for tests).
 *  Absolute and ~ paths pass through; relative ones join onto the cwd. */
export function resolveTermPath(path: string, cwd: string): string {
  if (path.startsWith('/') || path.startsWith('~')) return path
  const rel = path.replace(/^\.\//, '')
  const base = cwd.replace(/\/+$/, '')
  return base ? `${base}/${rel}` : rel
}

// ── URLs that span rows ──────────────────────────────────────────────────────
// xterm only joins SOFT-wrapped rows (isWrapped). Full-screen TUIs (Claude
// Code, Codex, ...) wrap long text themselves with cursor moves, so a long URL
// arrives as several unrelated rows, often indented, and the web-links addon
// only ever saw the first fragment. These helpers rebuild the logical URL.

export interface TermRow {
  /** the rendered row, trailing whitespace trimmed */
  text: string
  /** xterm soft-wrap continuation of the previous row */
  wrapped: boolean
}

export interface UrlLink {
  url: string
  /** 1-based inclusive cell coordinates, as xterm's IBufferRange wants */
  start: { x: number; y: number }
  end: { x: number; y: number }
}

const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g
/** frame glyphs a TUI draws around wrapped text; never part of a URL */
const EDGE = /[\s│┃║|]/
const URL_CHAR = /[^\s"'<>`{}|\\^│┃║]/
/** how far from the right edge a row may stop and still count as "full" */
const FULL_SLACK = 8
const MAX_ROWS = 8

function contentStart(text: string): number {
  let i = 0
  while (i < text.length && EDGE.test(text[i])) i++
  return i
}
function contentEnd(text: string): number {
  let i = text.length
  while (i > 0 && EDGE.test(text[i - 1])) i--
  return i
}

/** Does `next` continue a URL that was hard-wrapped at the end of `prev`? */
function hardContinues(prev: TermRow, next: TermRow, cols: number): boolean {
  const end = contentEnd(prev.text)
  const start = contentStart(prev.text)
  if (end <= start || end < cols - FULL_SLACK) return false
  if (!URL_CHAR.test(prev.text[end - 1])) return false
  const nextStart = contentStart(next.text)
  if (nextStart >= next.text.length || !URL_CHAR.test(next.text[nextStart])) return false
  // the row must end inside a URL: its last token holds the scheme, or the
  // whole row is one unbroken fragment (the middle of a 3+ row URL)
  const body = prev.text.slice(start, end)
  const lastToken = body.slice(body.search(/\S+$/))
  return lastToken.includes('://') || !/\s/.test(body)
}

/** Find URLs touching row `y` (0-based), following soft AND hard wraps. */
export function urlLinksAt(row: (y: number) => TermRow | undefined, y: number, cols: number): UrlLink[] {
  const joins = (a: number) => {
    const prev = row(a), next = row(a + 1)
    if (!prev || !next) return false
    return next.wrapped || hardContinues(prev, next, cols)
  }
  let top = y, bottom = y
  while (top > 0 && y - top < MAX_ROWS && joins(top - 1)) top--
  while (bottom - y < MAX_ROWS && joins(bottom)) bottom++

  // stitch the rows, remembering where every joined char came from
  let joined = ''
  const at: { x: number; y: number }[] = []
  for (let r = top; r <= bottom; r++) {
    const cur = row(r)
    if (!cur) break
    const softIn = r > top && cur.wrapped
    const hardIn = r > top && !softIn
    const hardOut = r < bottom && !row(r + 1)?.wrapped
    const from = hardIn ? contentStart(cur.text) : 0
    const to = hardOut ? contentEnd(cur.text) : cur.text.length
    for (let i = from; i < to; i++) {
      joined += cur.text[i]
      at.push({ x: i + 1, y: r + 1 })
    }
  }

  const out: UrlLink[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(joined))) {
    const start = at[m.index], end = at[m.index + m[0].length - 1]
    if (start.y > y + 1 || end.y < y + 1) continue
    out.push({ url: m[0], start, end })
  }
  return out
}
